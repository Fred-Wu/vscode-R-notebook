const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

exports.nativeFixtures = () => {
  const rscript = process.env.RSCRIPT_PATH || "Rscript";
  if (spawnSync(rscript, ["--version"], { windowsHide: true }).status !== 0) return [];
  require("tsx/cjs");
  const { parseDocument } = require("../../src/Notebook/document.ts");
  const { nativeTextDocument } = require("../../src/Notebook/markdown.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-notebook-native-fixtures-"));
  const fixtures = [];
  try {
    for (const extension of ["Rmd", "qmd"]) {
      const name = `rendering.${extension}`;
      const source = fs.readFileSync(path.join(__dirname, "../../examples", name), "utf8");
      const parsed = parseDocument(source);
      const ids = new Map(parsed.cells.flatMap((cell, index) =>
        cell.kind === "markup" ? [[index, `${extension}-${index}`]] : []));
      const native = nativeTextDocument(parsed.cells, ids, parsed.eol,
        extension === "qmd" ? "quarto" : "rMarkdown");
      const dir = path.join(root, extension);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, name), native.source);
      fs.writeFileSync(path.join(dir, "cells.json"), JSON.stringify(native.replacements));
      fixtures.push({ name, cells: native.cells.map(({ id, marker }) => ({ id, marker })) });
    }
    const script = [
      'args <- commandArgs(TRUE); source(args[[1L]], local=TRUE)',
      'for (extension in c("Rmd", "qmd")) {',
      '  dir <- file.path(args[[2L]], extension)',
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
      html: fs.readFileSync(path.join(root, path.extname(fixture.name).slice(1), "output/result.html"), "utf8"),
    }));
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("r-notebook-native-fixtures-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
};
