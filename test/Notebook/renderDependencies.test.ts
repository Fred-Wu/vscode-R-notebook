import assert from "node:assert/strict";
import test from "node:test";
import { isTextRenderDependency } from "../../src/Notebook/renderDependencies";

test("recognizes external references and styles for text invalidation", () => {
  for (const file of ["refs.bib", "apa.csl", "theme.css", "extra.scss",
    "chapter.md", "chapter.markdown", "before-body.html", "widget.js", "figure.svg"]) {
    assert.equal(isTextRenderDependency(file), true, file);
  }
  assert.equal(isTextRenderDependency("code.R"), false);
  assert.equal(isTextRenderDependency("data.csv"), false);
  assert.equal(isTextRenderDependency("refs.BIB"), true);
});
