import assert from "node:assert/strict";
import test from "node:test";
import {
  cellOptionsRequestId,
  codeCellLabel,
  codeCellRenderOptions,
  chunkEngine,
  chunkHeader,
  chunkHeaderFields,
  quartoOptionFields,
  quartoOptionLines,
  rMarkdownStatusHeader,
  updateChunkHeader,
  updateChunkHeaderFields,
  updateQuartoOptionFields,
  updateQuartoOptionLines,
} from "../../src/Notebook/options";

test("recognises temporary cell options metadata", () => {
  assert.equal(cellOptionsRequestId({ rNotebookCellOptions: "request-1" }), "request-1");
  assert.equal(cellOptionsRequestId({ rNotebookCellOptions: "" }), undefined);
  assert.equal(cellOptionsRequestId({ rNotebookCellOptions: {} }), undefined);
});

test("shows only active R Markdown headers in the cell status", () => {
  const headerChunk = {
    openingFence: "```{r model, echo=FALSE}\n",
    closingFence: "```\n",
    engine: "r",
  };
  const emptyChunk = {
    openingFence: "```{r}\n",
    closingFence: "```\n",
    engine: "r",
  };

  assert.equal(
    rMarkdownStatusHeader("report.Rmd", headerChunk, "summary(model)\n"),
    "{r model, echo=FALSE}"
  );
  assert.equal(
    rMarkdownStatusHeader("report.Rmd", emptyChunk, "#| label: model\nsummary(model)\n"),
    undefined
  );
  assert.equal(
    rMarkdownStatusHeader("report.qmd", headerChunk, "summary(model)\n"),
    undefined
  );
  assert.equal(
    rMarkdownStatusHeader("report.Rmd", emptyChunk, "summary(model)\n"),
    "{r}"
  );
});

test("reads and updates a native R Markdown chunk header", () => {
  const chunk = {
    openingFence: "```{r model, eval=FALSE, fig.cap=\"A } caption\"}\r\n",
    closingFence: "```\r\n",
    engine: "r",
  };

  assert.equal(
    chunkHeader(chunk.openingFence),
    'r model, eval=FALSE, fig.cap="A } caption"'
  );
  assert.equal(chunkEngine("{r, echo=FALSE}"), "r");
  assert.deepEqual(
    chunkHeaderFields('r model, eval=FALSE, fig.cap="A } caption"', "r"),
    { label: "model", options: 'eval=FALSE, fig.cap="A } caption"' }
  );
  assert.equal(
    updateChunkHeader(chunk, "r model, eval=TRUE").openingFence,
    "```{r model, eval=TRUE}\r\n"
  );
  assert.throws(
    () => updateChunkHeader(chunk, "python"),
    /engine must remain 'r'/
  );
  assert.equal(
    updateChunkHeaderFields(chunk, "updated-model", "echo=FALSE").openingFence,
    "```{r updated-model, echo=FALSE}\r\n"
  );
});

test("reads and updates leading Quarto pipe options", () => {
  const source = [
    "",
    "#| echo: false",
    "#| fig-cap: A caption",
    "plot(cars)",
    "#| not-an-option-here: true",
  ].join("\n");

  assert.deepEqual(quartoOptionLines(source), [
    "echo: false",
    "fig-cap: A caption",
  ]);
  assert.deepEqual(
    quartoOptionFields("#| label: model\n#| echo: false\nsummary(x)\n"),
    { label: "model", options: "echo: false" }
  );
  assert.equal(
    codeCellLabel("#| label: fig-aplot\nplot(cars)\n", undefined),
    "fig-aplot"
  );
  assert.equal(
    codeCellLabel("plot(cars)\n", {
      openingFence: "```{r fig-rmarkdown}\n",
      closingFence: "```\n",
      engine: "r",
    }),
    "fig-rmarkdown"
  );
  assert.deepEqual(
    [...codeCellRenderOptions([
      "#| label: fig-aplot",
      "#| fig-cap: A plot",
      "#| fig-align: center",
      "plot(cars)",
    ].join("\n"), undefined).attributes],
    [["fig-cap", "A plot"], ["fig-align", "center"]]
  );
  assert.deepEqual(
    [...codeCellRenderOptions("plot(cars)\n", {
      openingFence: '```{r fig-rmarkdown, fig.cap="A plot, with comma", fig.align="right"}\n',
      closingFence: "```\n",
      engine: "r",
    }).attributes],
    [["fig-cap", "A plot, with comma"], ["fig-align", "right"]]
  );
  assert.equal(
    updateQuartoOptionLines(source, "echo: true\nwarning: false"),
    [
      "",
      "#| echo: true",
      "#| warning: false",
      "plot(cars)",
      "#| not-an-option-here: true",
    ].join("\n")
  );
  assert.equal(
    updateQuartoOptionLines("\nplot(cars)\n", "eval: false"),
    "\n#| eval: false\nplot(cars)\n"
  );
  assert.equal(
    updateQuartoOptionLines("\n#| eval: false\nplot(cars)\n", ""),
    "\nplot(cars)\n"
  );
  assert.equal(
    updateQuartoOptionFields(
      "\n#| old: value\nplot(cars)\n",
      "model",
      "echo: false"
    ),
    "\n#| label: model\n#| echo: false\nplot(cars)\n"
  );
});
