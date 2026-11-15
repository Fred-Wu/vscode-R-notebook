import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

test("editor selectors use readable extensions and cover every supported casing", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const patterns = manifest.contributes.notebooks[0].selector.map(
    (selector: { filenamePattern: string }) => selector.filenamePattern
  );
  for (const first of "rRqQ") for (const second of "mM") for (const third of "dD") {
    const extension = first + second + third;
    assert.ok(patterns.includes(`*.${extension}`), `Missing editor selector for ${extension}`);
    assert.equal(normalizeNotebookExtension(`report.${extension}`), `.${extension.toLowerCase()}`);
  }
  assert.ok(patterns.every((pattern: string) => /^\*\.[rRqQ][mM][dD]$/.test(pattern)),
    "Set Default should show a plain extension, not a bracket glob");
});
