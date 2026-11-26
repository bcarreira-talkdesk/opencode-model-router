import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettingsWriter } from "./settings-store.js";

describe("SettingsWriter", () => {
  it("serializes concurrent mutations and preserves their order", async () => {
    const writer = new SettingsWriter();
    const values: number[] = [];
    await Promise.all([
      writer.enqueue(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); values.push(1); }),
      writer.enqueue(async () => { values.push(2); }),
    ]);
    assert.deepEqual(values, [1, 2]);
  });
});
