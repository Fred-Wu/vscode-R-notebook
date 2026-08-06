import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "../../src/Notebook/document";
import {
  nativeCodeOptionSignature,
  nativeTextDocument,
} from "../../src/Notebook/markdown";

test("tracks code options without tracking executable code", () => {
  const original = parseDocument([
    "```{r model, fig.cap=\"A plot\"}\n",
    "#| echo: false\n",
    "plot(cars)\n",
    "```\n",
  ].join(""));
  const codeChange = parseDocument([
    "```{r model, fig.cap=\"A plot\"}\n",
    "#| echo: false\n",
    "plot(pressure)\n",
    "```\n",
  ].join(""));
  const pipeOptionChange = parseDocument([
    "```{r model, fig.cap=\"A plot\"}\n",
    "#| echo: true\n",
    "plot(cars)\n",
    "```\n",
  ].join(""));
  const headerChange = parseDocument([
    "```{r changed, fig.cap=\"A plot\"}\n",
    "#| echo: false\n",
    "plot(cars)\n",
    "```\n",
  ].join(""));

  const signature = nativeCodeOptionSignature(original.cells);
  assert.equal(nativeCodeOptionSignature(codeChange.cells), signature);
  assert.notEqual(nativeCodeOptionSignature(pipeOptionChange.cells), signature);
  assert.notEqual(nativeCodeOptionSignature(headerChange.cells), signature);
});

test("builds a text-only native snapshot with cell boundaries", () => {
  const source = [
    "---\r\n",
    "title: Native text\r\n",
    "---\r\n",
    "\r\n",
    "# Section {#sec-one}\r\n",
    "\r\n",
    "```{r}\r\n",
    "value <- 42\r\n",
    "```\r\n",
    "\r\n",
    "See @sec-one and `r value`.\r\n",
  ].join("");
  const parsed = parseDocument(source);
  const native = nativeTextDocument(
    parsed.cells,
    new Map([[0, "first"], [2, "second"]]),
    parsed.eol,
    "quarto"
  );

  assert.equal(native.cells.length, 2);
  assert.equal(native.replacements.length, 2);
  assert.equal(native.cells[0]?.source, "\r\n# Section {#sec-one}\r\n\r\n");
  assert.equal(native.cells[1]?.source, "\r\nSee @sec-one and `r value`.\r\n");
  assert.match(native.source, /^---\r\ntitle: Native text\r\n---\r\n/);
  assert.match(native.source, /#r-notebook-markdown-first/);
  assert.match(native.source, /VSC_R_NOTEBOOK_MARKDOWN_second/);
  assert.match(native.source, /<!-- r-notebook-code-cell -->/);
  assert.doesNotMatch(native.source, /value <- 42/);
  assert.doesNotMatch(native.source, /See @sec-one/);
});

test("does not expose executable chunk options to the Markdown renderer", () => {
  const parsed = parseDocument([
    "Before\n\n",
    "```{r model, echo=false}\n",
    "stop('must not be parsed')\n",
    "```\n\n",
    "After\n",
  ].join(""));
  const native = nativeTextDocument(
    parsed.cells,
    new Map([[0, "before"], [2, "after"]]),
    parsed.eol,
    "quarto"
  );

  assert.doesNotMatch(native.source, /echo=false|must not be parsed/);
  assert.match(native.source, /r-notebook-markdown-before/);
  assert.match(native.source, /r-notebook-markdown-after/);
});

test("keeps code cell labels as non-executable cross-reference targets", () => {
  const parsed = parseDocument([
    "Before\n\n",
    "```{r}\n",
    "#| label: fig-aplot\n",
    "#| fig-cap: A plot\n",
    "plot(cars)\n",
    "```\n\n",
    "See @fig-aplot.\n",
  ].join(""));
  const native = nativeTextDocument(
    parsed.cells,
    new Map([[0, "before"], [2, "after"]]),
    parsed.eol,
    "quarto"
  );

  assert.match(native.source, /::: \{#fig-aplot fig-cap="A plot"\}\n:::/);
  assert.equal(native.replacements[1]?.source, "\nSee @fig-aplot.\n");
  assert.doesNotMatch(native.source, /#\| (?:label|fig-cap):|plot\(cars\)/);
});

test("builds non-executable bookdown figure targets for R Markdown", () => {
  const parsed = parseDocument([
    "Before\n\n",
    '```{r aplot, fig.cap="A plot"}\n',
    "plot(cars)\n",
    "```\n\n",
    "See Figure \\@ref(fig:aplot).\n",
  ].join(""));
  const native = nativeTextDocument(
    parsed.cells,
    new Map([[0, "before"], [2, "after"]]),
    parsed.eol,
    "rMarkdown"
  );

  assert.match(native.source, /<p class="caption">\(\\#fig:aplot\) A plot<\/p>/);
  assert.equal(native.replacements[1]?.source, "\nSee Figure \\@ref(fig:aplot).\n");
  assert.doesNotMatch(native.source, /plot\(cars\)/);
});

test("does not invent a bookdown figure target without a caption", () => {
  const parsed = parseDocument([
    "```{r}\n",
    "#| label: test\n",
    "plot(cars)\n",
    "```\n\n",
    "See Figure \\@ref(fig:test).\n",
  ].join(""));
  const native = nativeTextDocument(
    parsed.cells,
    new Map([[1, "reference"]]),
    parsed.eol,
    "rMarkdown"
  );

  assert.doesNotMatch(native.source, /\\#fig:test/);
  assert.match(native.replacements[0]?.source ?? "", /\\@ref\(fig:test\)/);
  assert.doesNotMatch(native.source, /plot\(cars\)/);
});
