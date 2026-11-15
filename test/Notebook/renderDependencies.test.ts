import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isTextRenderDependency, sourceReferencesDependency, quartoProjectReferencesDependency, hasQuartoProjectConfiguration, TEXT_RENDER_DEPENDENCY_GLOB } from "../../src/Notebook/renderDependencies";

test("recognizes external references and styles for text invalidation", () => {
  for (const file of ["refs.bib", "apa.csl", "theme.css", "extra.scss",
    "chapter.md", "chapter.markdown", "partial.qmd", "partial.Rmd",
    "before-body.html", "widget.js", "figure.svg", "plot.png", "plot.PNG",
    "photo.JpEg", "photo.jpg", "animation.gif", "plot.webp", "plot.avif",
    "plot.bmp", "plot.tif", "plot.tiff", "plot.ico", "plot.pdf", "plot.eps"]) {
    assert.equal(isTextRenderDependency(file), true, file);
    assert.equal(path.matchesGlob(`/project/${file}`, TEXT_RENDER_DEPENDENCY_GLOB), true, file);
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
  assert.equal(sourceReferencesDependency(
    "100% complete. ![Plot](generated%20plot.PNG)", "/project/generated plot.PNG"
  ), true);
  assert.equal(sourceReferencesDependency(
    "![Plot](caf%c3%a9.PNG)", "/project/café.PNG"
  ), true);
  assert.equal(sourceReferencesDependency("Literal %ff and refs.bib", "/project/refs.bib"), true);
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
