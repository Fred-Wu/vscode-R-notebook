import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultChunk,
  parseDocument,
  serializeDocument,
  type ParsedCell,
} from "../../src/Notebook/document";

test("parses R Markdown chunks and round trips without changing bytes", () => {
  const source = [
    "---\r\n",
    "title: Test\r\n",
    "---\r\n",
    "\r\n",
    "Text before.\r\n",
    "\r\n",
    "```{r plot, echo=FALSE, fig.width=7}\r\n",
    "plot(1:3)\r\n",
    "```\r\n",
    "\r\n",
    "Text after.\r\n",
  ].join("");

  const parsed = parseDocument(source);
  assert.equal(parsed.eol, "\r\n");
  assert.equal(parsed.cells.length, 3);
  assert.equal(parsed.cells[1]?.kind, "code");
  assert.equal(parsed.cells[1]?.languageId, "r");
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("preserves Quarto options and different fence markers", () => {
  const source = [
    "~~~{r}\n",
    "#| warning: false\n",
    "#| layout: [[45, -10, 45], [100]]\n",
    "plot(cars)\n",
    "plot(pressure)\n",
    "plot(mtcars)\n",
    "~~~~\n",
  ].join("");
  const parsed = parseDocument(source);
  assert.equal(parsed.cells.length, 1);
  assert.match(parsed.cells[0]?.value ?? "", /layout: \[\[45, -10, 45\], \[100\]\]/);
  assert.equal(parsed.cells[0]?.chunk?.openingFence, "~~~{r}\n");
  assert.equal(parsed.cells[0]?.chunk?.closingFence, "~~~~\n");
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("round trips native option expressions and multiline Quarto YAML verbatim", () => {
  const source = [
    "```{r native, fig.width=base_width * 2, dev=c('png', 'svg'), dev.args=list(png=list(bg='transparent'))}\n",
    "#| out-width: !expr paste0(display_width, '%')\n",
    "#| fig-cap: |\n",
    "#|   A caption with: punctuation, quotes, and [brackets].\n",
    "#| custom-option:\n",
    "#|   nested: [1, 2, 3]\n",
    "plot(cars)\n",
    "```\n",
  ].join("");

  const parsed = parseDocument(source);
  assert.equal(parsed.cells.length, 1);
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("recognises R Markdown headers with closing braces inside native option values", () => {
  const header = "r braces, fig.cap=\"A } caption\", dev.args=list(png=list(bg='}'))";
  const source = `\`\`\`{${header}}\nplot(cars)\n\`\`\`\n`;

  const parsed = parseDocument(source);
  assert.equal(parsed.cells.length, 1);
  assert.equal(parsed.cells[0]?.kind, "code");
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("does not recognise apparent chunks nested inside an ordinary Markdown fence", () => {
  const source = [
    "````markdown\n",
    "An example, not an executable chunk:\n",
    "```{r nested, echo=FALSE}\n",
    "stop('must not become a cell')\n",
    "```\n",
    "````\n",
  ].join("");

  const parsed = parseDocument(source);
  assert.deepEqual(parsed.cells, [
    { kind: "markup", value: source, languageId: "markdown" },
  ]);
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("keeps Pandoc attributed fences as Markdown and recognises the next native chunk", () => {
  const attributed = [
    "```{.r #example}\n",
    "x <- 1\n",
    "```\n",
    "\n",
  ].join("");
  const native = "```{r actual, fig.cap=\"A } caption\"}\ny <- 2\n```\n";
  const source = attributed + native;

  const parsed = parseDocument(source);
  assert.equal(parsed.cells.length, 2);
  assert.deepEqual(parsed.cells[0], {
    kind: "markup",
    value: attributed,
    languageId: "markdown",
  });
  assert.equal(parsed.cells[1]?.kind, "code");
  assert.equal(parsed.cells[1]?.chunk?.engine, "r");
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("leaves ordinary and unclosed fenced blocks in Markdown", () => {
  const source = "Before\n\n```r\nx <- 1\n```\n\n```{r}\nunclosed\n";
  const parsed = parseDocument(source);
  assert.deepEqual(parsed.cells, [
    { kind: "markup", value: source, languageId: "markdown" },
  ]);
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});

test("uses a valid default fence for a newly inserted code cell", () => {
  const cells: ParsedCell[] = [
    { kind: "markup", value: "Heading", languageId: "markdown" },
    { kind: "code", value: "summary(cars)", languageId: "r" },
  ];
  assert.equal(
    serializeDocument(cells, "\n"),
    "Heading\n```{r}\nsummary(cars)\n```"
  );
  assert.deepEqual(defaultChunk("python", "\r\n"), {
    openingFence: "```{python}\r\n",
    closingFence: "```",
    engine: "python",
  });
});

test("preserves whitespace between code chunks without creating an empty Markdown cell", () => {
  const source = [
    "```{r}\n",
    "x <- 1\n",
    "```\n",
    "\n",
    "```{r}\n",
    "x + 1\n",
    "```\n",
  ].join("");
  const parsed = parseDocument(source);

  assert.deepEqual(parsed.cells.map((cell) => cell.kind), ["code", "code"]);
  assert.equal(serializeDocument(parsed.cells, parsed.eol), source);
});
