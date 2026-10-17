import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentTextResponse, shouldReloadHeadScripts } from "../../src/Renderer/textResult";

test("text render responses update only the cell that requested them", () => {
  assert.equal(isCurrentTextResponse("old", "old"), true);
  assert.equal(isCurrentTextResponse("new", "old"), false);
  assert.equal(isCurrentTextResponse(undefined, "old"), false);
  assert.equal(isCurrentTextResponse("other-cell", "old"), false);
});

test("reloads head scripts only when declarations change", () => {
  assert.equal(shouldReloadHeadScripts(undefined, ""), true);
  assert.equal(shouldReloadHeadScripts("<script>a</script>", "<script>a</script>"), false);
  assert.equal(shouldReloadHeadScripts("<script>a</script>", "<script>b</script>"), true);
});
