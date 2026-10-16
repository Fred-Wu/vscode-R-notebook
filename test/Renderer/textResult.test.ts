import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentTextResponse } from "../../src/Renderer/textResult";

test("text render responses update only the cell that requested them", () => {
  assert.equal(isCurrentTextResponse("old", "old"), true);
  assert.equal(isCurrentTextResponse("new", "old"), false);
  assert.equal(isCurrentTextResponse(undefined, "old"), false);
  assert.equal(isCurrentTextResponse("other-cell", "old"), false);
});
