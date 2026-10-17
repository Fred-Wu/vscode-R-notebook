import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentTextResponse, shouldDisplayRenderingError, clearRenderingErrors, shouldReloadHeadScripts, isAllowedNativeScriptSource, isAllowedNativeStylesheetSource } from "../../src/Renderer/textResult";

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

test("deduplicates repeated document-level render errors", () => {
  const seen = new Set<string>();
  assert.equal(shouldDisplayRenderingError(seen, "report.qmd", "Quarto failed"), true);
  assert.equal(shouldDisplayRenderingError(seen, "Quarto failed"), false);
  assert.equal(shouldDisplayRenderingError(seen, "report.qmd", "Missing bibliography"), true);
});

test("native text runs embedded scripts without loading remote dependencies", () => {
  assert.equal(isAllowedNativeScriptSource(null), true);
  assert.equal(isAllowedNativeScriptSource("data:text/javascript;base64,AA=="), true);
  assert.equal(isAllowedNativeScriptSource("https://example.com/script.js"), false);
  assert.equal(isAllowedNativeScriptSource("//example.com/script.js"), false);
  assert.equal(isAllowedNativeScriptSource("file:///tmp/script.js"), false);
  assert.equal(isAllowedNativeScriptSource("javascript:alert(1)"), false);
});

test("allows embedded stylesheets but not remote stylesheets", () => {
  assert.equal(isAllowedNativeStylesheetSource("data:text/css;base64,YQ=="), true);
  assert.equal(isAllowedNativeStylesheetSource("data:text/css,body%7B%7D"), true);
  assert.equal(isAllowedNativeStylesheetSource("https://example.com/theme.css"), false);
  assert.equal(isAllowedNativeStylesheetSource("file:///tmp/theme.css"), false);
  assert.equal(isAllowedNativeStylesheetSource(null), false);
});

test("document errors do not suppress errors in another notebook", () => {
  const seen = new Set<string>();
  assert.equal(shouldDisplayRenderingError(seen, "a.qmd", "Quarto failed"), true);
  assert.equal(shouldDisplayRenderingError(seen, "b.qmd", "Quarto failed"), true);
  assert.equal(shouldDisplayRenderingError(seen, "a.qmd", "Quarto failed"), false);
  clearRenderingErrors(seen, "a.qmd");
  assert.equal(shouldDisplayRenderingError(seen, "a.qmd", "Quarto failed"), true);
  assert.equal(shouldDisplayRenderingError(seen, "b.qmd", "Quarto failed"), false);
});
