/** Serialized merge helper for concurrent plugin-settings RPC updates. */
export class SettingsWriter {
  private tail: Promise<void> = Promise.resolve();

  /** Run one storage mutation at a time, preserving unrelated field updates. */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}
