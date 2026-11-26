/**
 * Serialized-admission helper for OpenCode's prompt hook.
 *
 * OpenCode V2.3.2 can run a queued prompt inside the previous prompt's model
 * execution with no idle/terminal event between the two. Because
 * `switchModel` affects later steps of a running prompt, an automatic router
 * must not admit a busy-session prompt until that execution reaches a terminal
 * boundary. This class tracks terminal events and gives each prompt hook an
 * abortable, bounded wait.
 */

import type { ModelRef } from "../config.js";

/** Minimal session state needed to recover busy state after plugin hot reload. */
export interface AdmissionSessionSnapshot {
  readonly time?: { readonly busy?: number; readonly idle?: number };
  readonly model?: ModelRef;
}

/** Determines whether persisted timestamps show a busy execution. */
export function snapshotIsBusy(snapshot: AdmissionSessionSnapshot | undefined): boolean {
  const busy = snapshot?.time?.busy;
  if (busy === undefined) return false;
  return busy > (snapshot?.time?.idle ?? 0);
}

type Waiter = {
  readonly messageID: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Serializes busy-session prompt admission and releases waiters FIFO. */
export class AdmissionSerializer {
  private readonly busy = new Set<string>();
  private readonly pendingStart = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter[]>();
  private failed: Error | undefined;
  private disposed = false;

  constructor(private readonly timeoutMs: number = 120_000) {}

  /** Mark that execution is active. This does not release prompt identity. */
  started(sessionID: string): void {
    if (this.disposed || this.failed) return;
    this.busy.add(sessionID);
  }

  /** Acknowledge the exact admitted prompt when OpenCode delivers its inbox item. */
  delivered(sessionID: string, messageID: string): void {
    if (this.pendingStart.get(sessionID) === messageID) {
      this.pendingStart.delete(sessionID);
    }
  }

  /** Seed busy state from `SessionInfo` after setup or hot reload. */
  seed(sessionID: string, snapshot: AdmissionSessionSnapshot | undefined): void {
    if (!this.disposed && !this.failed && snapshotIsBusy(snapshot)) this.busy.add(sessionID);
  }

  /** Release exactly one FIFO waiter after a verified terminal boundary. */
  terminal(sessionID: string): void {
    if (this.pendingStart.has(sessionID)) return;
    const pending = this.waiters.get(sessionID);
    const next = pending?.shift();
    if (!next) {
      this.busy.delete(sessionID);
      this.waiters.delete(sessionID);
      return;
    }
    this.busy.add(sessionID);
    this.pendingStart.set(sessionID, next.messageID);
    if (pending && pending.length === 0) this.waiters.delete(sessionID);
    clearTimeout(next.timer);
    next.resolve();
  }

  /**
   * Mark a reserved hook as aborted before durable admission. This is for
   * errors, inbox cancellation, or mode-off transitions only; a routed/no-op
   * prompt continues and is acknowledged by `inbox.delivered`.
   */
  cancel(sessionID: string, messageID: string): void {
    const pendingID = this.pendingStart.get(sessionID);
    if (pendingID !== messageID) return;
    this.pendingStart.delete(sessionID);
    this.releaseNextAfterCancel(sessionID);
  }

  private releaseNextAfterCancel(sessionID: string): void {
    const pending = this.waiters.get(sessionID);
    const next = pending?.shift();
    if (!next) {
      this.busy.delete(sessionID);
      this.waiters.delete(sessionID);
      return;
    }
    this.busy.add(sessionID);
    this.pendingStart.set(sessionID, next.messageID);
    if (pending && pending.length === 0) this.waiters.delete(sessionID);
    clearTimeout(next.timer);
    next.resolve();
  }

  /** Fail closed if lifecycle events stop arriving. */
  fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.waiters.values()) {
      for (const waiter of pending.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    this.busy.clear();
    this.pendingStart.clear();
  }

  /** Current tracked busy state for status/reporting. */
  isBusy(sessionID: string): boolean {
    return this.busy.has(sessionID);
  }

  /** Await a safe execution boundary, reserving the permit before resolving. */
  wait(sessionID: string, messageID: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("router is disposing; prompt not admitted"));
    if (this.failed) return Promise.reject(this.failed);
    if (!this.busy.has(sessionID)) {
      this.busy.add(sessionID);
      this.pendingStart.set(sessionID, messageID);
      return Promise.resolve();
    }
    if (this.pendingStart.get(sessionID) === messageID) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const pending = this.waiters.get(sessionID) ?? [];
      const waiter: Waiter = {
        messageID,
        resolve,
        reject,
        timer: setTimeout(() => {
          const queue = this.waiters.get(sessionID);
          const index = queue?.indexOf(waiter) ?? -1;
          if (queue && index >= 0) queue.splice(index, 1);
          if (queue?.length === 0) this.waiters.delete(sessionID);
          reject(new Error(`router admission wait timed out after ${this.timeoutMs}ms for ${messageID}`));
        }, this.timeoutMs),
      };
      pending.push(waiter);
      this.waiters.set(sessionID, pending);
    });
  }

  /** Release pending prompt hooks on teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error("router disposed during prompt admission"));
  }
}
