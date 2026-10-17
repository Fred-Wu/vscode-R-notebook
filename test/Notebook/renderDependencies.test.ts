import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isTextRenderDependency, sourceReferencesDependency, quartoProjectReferencesDependency, hasQuartoProjectConfiguration } from "../../src/Notebook/renderDependencies";

test("recognizes external references and styles for text invalidation", () => {
  for (const file of ["refs.bib", "apa.csl", "theme.css", "extra.scss",
    "chapter.md", "chapter.markdown", "partial.qmd", "partial.Rmd",
    "before-body.html", "widget.js", "figure.svg"]) {
    assert.equal(isTextRenderDependency(file), true, file);
  }
  assert.equal(isTextRenderDependency("code.R"), false);
  assert.equal(isTextRenderDependency("data.csv"), false);
  assert.equal(isTextRenderDependency("refs.BIB"), true);
  assert.equal(isTextRenderDependency("crossref.lua"), true);
});

test("limits resource invalidation to source references", () => {
  const document = 'bibliography: references.bib\ncss: custom.css\n';
  assert.equal(sourceReferencesDependency(document, "/project/references.bib"), true);
  assert.equal(sourceReferencesDependency(document, "/project/custom.css"), true);
  assert.equal(sourceReferencesDependency(document, "/project/unrelated.bib"), false);
});

test("detects Quarto resources inherited from project configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-dependency-"));
  try {
    const chapter = path.join(root, "chapters");
    await fs.mkdir(chapter);
    const notebook = path.join(chapter, "chapter.qmd");
    assert.equal(await hasQuartoProjectConfiguration(notebook), false);
    await fs.writeFile(path.join(root, "_quarto.yml"),
      "bibliography: references.bib\nfilters: [crossref.lua]\n");
    await fs.writeFile(path.join(chapter, "_metadata.yml"), "css: custom.css\n");
    assert.equal(await hasQuartoProjectConfiguration(notebook), true);
    assert.equal(await quartoProjectReferencesDependency(
      notebook, path.join(root, "references.bib")
    ), true);
    assert.equal(await quartoProjectReferencesDependency(
      notebook, path.join(root, "crossref.lua")
    ), true);
    assert.equal(await quartoProjectReferencesDependency(
      notebook, path.join(chapter, "custom.css")
    ), true);
    assert.equal(await quartoProjectReferencesDependency(
      notebook, path.join(root, "unrelated.bib")
    ), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
