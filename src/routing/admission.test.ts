import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdmissionSerializer, snapshotIsBusy } from "./admission.js";

describe("admission serializer", () => {
  it("reserves idle admission and releases busy waiters one at a time", async () => {
    const serializer = new AdmissionSerializer(500);
    await serializer.wait("s1", "m0");
    serializer.started("s1");
    serializer.delivered("s1", "m0");

    let firstReleased = false;
    let secondReleased = false;
    const first = serializer.wait("s1", "m1").then(() => { firstReleased = true; });
    const second = serializer.wait("s1", "m2").then(() => { secondReleased = true; });
    assert.equal(firstReleased, false);
    assert.equal(secondReleased, false);
    serializer.terminal("s1");
    await first;
    assert.equal(firstReleased, true);
    assert.equal(secondReleased, false);
    // A duplicate idle/terminal event for the prior execution must not open a
    // second permit before the newly released prompt starts.
    serializer.terminal("s1");
    assert.equal(secondReleased, false);
    serializer.started("s1");
    serializer.delivered("s1", "m1");
    serializer.terminal("s1");
    await second;
    assert.equal(secondReleased, true);
  });

  it("isolates concurrent sessions", async () => {
    const serializer = new AdmissionSerializer(500);
    await serializer.wait("s1", "m1");
    await serializer.wait("s2", "m2");
    serializer.started("s1");
    serializer.delivered("s1", "m1");
    let s2Released = false;
    const waitingS1 = serializer.wait("s1", "queued-s1");
    const waitingS2 = serializer.wait("s2", "queued-s2").then(() => { s2Released = true; });
    serializer.terminal("s1");
    await waitingS1;
    assert.equal(s2Released, false);
    serializer.started("s2");
    serializer.delivered("s2", "m2");
    serializer.terminal("s2");
    await waitingS2;
    assert.equal(s2Released, true);
  });

  it("seeds busy state from persisted timestamps after reload", async () => {
    assert.equal(snapshotIsBusy({ time: { busy: 20, idle: 10 } }), true);
    assert.equal(snapshotIsBusy({ time: { busy: 10, idle: 20 } }), false);
    const serializer = new AdmissionSerializer(10);
    serializer.seed("s1", { time: { busy: 20, idle: 10 } });
    await assert.rejects(() => serializer.wait("s1", "m1"), /timed out/);
  });

  it("cancels the exact pending inbox identity and ignores unrelated cancellations", async () => {
    const serializer = new AdmissionSerializer(100);
    await serializer.wait("s1", "m1");
    serializer.cancel("s1", "other");
    assert.equal(serializer.isBusy("s1"), true);
    serializer.cancel("s1", "m1");
    assert.equal(serializer.isBusy("s1"), false);
  });

  it("fails queued admissions immediately when lifecycle events fail", async () => {
    const serializer = new AdmissionSerializer(500);
    serializer.started("s1");
    const waiting = serializer.wait("s1", "m1");
    serializer.fail(new Error("event stream failed"));
    await assert.rejects(() => waiting, /event stream failed/);
    await assert.rejects(() => serializer.wait("s2", "m2"), /event stream failed/);
  });

  it("rejects all waiters on disposal without leaking timers", async () => {
    const serializer = new AdmissionSerializer(500);
    serializer.started("s1");
    const waiting = serializer.wait("s1", "m1");
    serializer.dispose();
    await assert.rejects(() => waiting, /disposed/);
  });
});
