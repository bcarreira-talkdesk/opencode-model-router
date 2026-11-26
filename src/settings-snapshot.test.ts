import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "./config.js";
import { sameModel } from "./models.js";

const equal = (left: typeof DEFAULT_SETTINGS.simpleModel, right: typeof DEFAULT_SETTINGS.simpleModel) => left === null && right === null ? true : sameModel(left, right);

describe("settings snapshot model equality", () => {
  it("treats identical null role models as unchanged", () => {
    assert.equal(equal(null, null), true);
  });
  it("detects a model change while preserving normalized default variants", () => {
    assert.equal(equal({ providerID: "p", id: "m" }, { providerID: "p", id: "m", variant: "default" }), true);
    assert.equal(equal({ providerID: "p", id: "m" }, { providerID: "p", id: "other" }), false);
  });
});
