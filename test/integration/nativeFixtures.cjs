const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

exports.fixtureSource = (extension) => [
  "---",
  `title: "${extension.toLowerCase() === "qmd" ? "Horizon" : "This is a test"}"`,
  'author: "Fred Wu"',
  'date: "2026-10-17"',
  ...(extension.toLowerCase() === "qmd" ? [
    "format:", "  html:", "    code-fold: true", "    toc: true", "    toc-depth: 2",
  ] : [
    "output:", "  word_document: default", "  html_document:", "    toc: true", "    toc_depth: 2",
  ]),
  "---", "", "An introductory paragraph immediately before the first heading.",
  "# Introduction", "", "This section appears in the table of contents.", "",
  "```{r}", "mean(c(2, 4, 6))", "```", "",
  "# Results", "", "The code cell prints 4 when run.", "",
  "## A plot", "", "```{r}", "plot(1:3)", "```", "",
].join("\n");

exports.nativeFixtures = () => {
  const rscript = process.env.RSCRIPT_PATH || "Rscript";
  if (spawnSync(rscript, ["--version"], { windowsHide: true }).status !== 0) return [];
  require("tsx/cjs");
  const { parseDocument } = require("../../src/Notebook/document.ts");
  const { nativeTextDocument } = require("../../src/Notebook/markdown.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-notebook-native-fixtures-"));
  const fixtures = [];
  try {
    for (const [index, extension] of ["rmd", "Rmd", "RMD", "qmd", "QMD"].entries()) {
      const name = `rendering.${extension}`;
      const source = exports.fixtureSource(extension);
      const parsed = parseDocument(source);
      const ids = new Map(parsed.cells.flatMap((cell, index) =>
        cell.kind === "markup" ? [[index, `${extension}-${index}`]] : []));
      const native = nativeTextDocument(parsed.cells, ids, parsed.eol,
        extension.toLowerCase() === "qmd" ? "quarto" : "rMarkdown");
      const directory = `${index}-${extension}`;
      const dir = path.join(root, directory);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, name), native.source);
      fs.writeFileSync(path.join(dir, "cells.json"), JSON.stringify(native.replacements));
      fixtures.push({ name, directory, cells: native.cells.map(({ id, marker }) => ({ id, marker })) });
    }
    const script = [
      'args <- commandArgs(TRUE); source(args[[1L]], local=TRUE)',
      'for (directory in list.dirs(args[[2L]], recursive=FALSE, full.names=FALSE)) {',
      '  dir <- file.path(args[[2L]], directory)',
      '  extension <- sub("^[0-9]+-", "", directory)',
      '  output <- file.path(dir, "output"); dir.create(output)',
      '  r_notebook_render_text(file.path(dir, "cells.json"), file.path(dir, paste0("rendering.", extension)), output, dir, .GlobalEnv)',
      '  if (!identical(readLines(file.path(output, "done")), "true")) stop(paste(readLines(file.path(output, "error.txt")), collapse="\\n"))',
      '}',
    ].join("\n");
    fs.writeFileSync(path.join(root, "render.R"), script);
    const result = spawnSync(rscript, [path.join(root, "render.R"),
      path.resolve(__dirname, "../../resources/r/execute.R"), root],
    { encoding: "utf8", timeout: 120000, windowsHide: true });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    return fixtures.map((fixture) => ({ ...fixture,
      html: fs.readFileSync(path.join(root, fixture.directory, "output/result.html"), "utf8"),
    }));
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("r-notebook-native-fixtures-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
};
