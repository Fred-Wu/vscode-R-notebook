import assert from "node:assert/strict";
import test from "node:test";
import { needsNativeTextRender, needsNativeDocumentRender } from "../../src/Renderer/nativeMarkdown";

test("ordinary Markdown uses VS Code native rendering", () => {
  for (const source of [
    "# Overview\n\nPlain **Markdown** paragraph.",
    "- A\n- B\n\n| x | y |\n| - | - |\n| 1 | 2 |",
    "![ordinary image](plot.png)",
    "A [regular link](https://example.org).",
    "\n\n",
  ]) {
    assert.equal(needsNativeTextRender(source), false, source);
  }
});

test("Quarto and knitr features retain document-wide rendering", () => {
  for (const source of [
    "The value is \`r sum(1:10)\`.",
    "See @fig-test and @tbl-data.",
    "See Figure \\@ref(fig:plot).",
    "See [@some-paper].",
    "As demonstrated by @some-paper.",
    "# Results {#sec-results}",
    "![Plot](plot.png){#fig-test}",
    "::: {.callout-note}\nHello\n:::",
    "{{< include partial.qmd >}}",
  ]) {
    assert.equal(needsNativeTextRender(source), true, source);
  }
});

test("a document-wide decision preserves cross-cell Quarto semantics", () => {
  const text = { kind: "markup" as const, value: "# Chapter\n" };
  const reference = { kind: "markup" as const, value: "See @fig-plot.\n" };
  const code = { kind: "code" as const, value: "plot(cars)", chunk: { openingFence: "```{r}\n" } };
  assert.equal(needsNativeDocumentRender([text, code]), false);
  assert.equal(needsNativeDocumentRender([text, reference, code]), true);
  assert.equal(needsNativeDocumentRender([{
    kind: "markup", value: "---\nnumber-sections: true\n---\n"
  }, text]), true);
});
