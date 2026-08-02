import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuartoNotebook,
  normalizeNotebookExtension,
} from "../../src/notebookFile";

test("normalizes R Markdown and Quarto filename extensions", () => {
  assert.equal(normalizeNotebookExtension("report.Rmd"), ".rmd");
  assert.equal(normalizeNotebookExtension("report.rmd"), ".rmd");
  assert.equal(normalizeNotebookExtension("report.Qmd"), ".qmd");
  assert.equal(normalizeNotebookExtension("report.qmd"), ".qmd");
  assert.equal(normalizeNotebookExtension("report.RMD"), ".rmd");
  assert.equal(normalizeNotebookExtension("report.QMD"), ".qmd");
});

test("rejects unrelated extensions after normalization", () => {
  assert.equal(normalizeNotebookExtension("report.md"), undefined);
  assert.equal(normalizeNotebookExtension("report.rmd.txt"), undefined);
  assert.equal(isQuartoNotebook("report.Rmd"), false);
  assert.equal(isQuartoNotebook("report.Qmd"), true);
});
