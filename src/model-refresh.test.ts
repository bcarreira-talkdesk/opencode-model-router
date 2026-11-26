import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelRefresh } from "./model-refresh.js";

describe("ModelRefresh", () => {
  it("shares one in-flight request and discards pre-invalidation generations", async () => {
    const refresh = new ModelRefresh<string[]>();
    let release: ((models: string[]) => void) | undefined;
    const load = () => new Promise<string[]>((resolve) => { release = resolve; });
    let calls = 0;
    const counted = () => { calls++; return load(); };
    const a = refresh.run(counted);
    const b = refresh.run(counted);
    assert.equal(calls, 1);
    refresh.invalidate();
    release?.(["old"]);
    const old = await a;
    assert.equal(refresh.current(old.generation), false);
    const fresh = await refresh.run(async () => ["new"]);
    assert.deepEqual(fresh.data, ["new"]);
    assert.equal(refresh.current(fresh.generation), true);
  });
});
