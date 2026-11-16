const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const rscript = process.env.RSCRIPT_PATH || "Rscript";
const available = spawnSync(rscript, ["--version"], { windowsHide: true }).status === 0;
if (process.env.CI) assert.ok(available, "CI requires R for notebook cross-reference tests");

test("litedown resolves Quarto references through notebook cell placeholders without publishing tools",
  { skip: !available && "Rscript is not installed" }, () => {
    require("tsx/cjs");
    const { parseDocument } = require("../../src/Notebook/document.ts");
    const { nativeTextDocument } = require("../../src/Notebook/markdown.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r-notebook-crossref-"));
    try {
      const source = [
        "---", "title: Reference validation", "format: html", "---", "",
        "See @fig-nb-test and @tbl-nb-test.", "",
        "```{r}", "#| label: fig-nb-test", "#| fig-cap: A test figure", "stop('must not run')", "```", "",
        "```{r}", "#| label: tbl-nb-test", "#| tbl-cap: A test table", "stop('must not run')", "```", "",
      ].join("\n");
      const parsed = parseDocument(source);
      const ids = new Map(parsed.cells.flatMap((cell, index) => cell.kind === "markup" ? [[index, String(index)]] : []));
      const native = nativeTextDocument(parsed.cells, ids, parsed.eol, "quarto");
      fs.writeFileSync(path.join(dir, "test.qmd"), native.source);
      fs.writeFileSync(path.join(dir, "cells.json"), JSON.stringify(native.replacements));
      const helper = path.resolve("resources/r/execute.R").replaceAll("\\", "/");
      const script = [
        'args <- commandArgs(TRUE)',
        'source(args[[1L]], local=TRUE); r_notebook_load(dirname(args[[1L]]))',
        'trace(base::system2, tracer=quote(stop("Unexpected external renderer")), print=FALSE)',
        'r_notebook_render_text("cells.json", "test.qmd", ".", getwd(), .GlobalEnv)',
        'if (!identical(readLines("done"), "true")) stop(paste(readLines("error.txt"), collapse="\\n"))',
      ].join("\n");
      fs.writeFileSync(path.join(dir, "render.R"), script);
      execFileSync(rscript, ["render.R", helper], { cwd: dir, windowsHide: true, encoding: "utf8" });
      const html = fs.readFileSync(path.join(dir, "result.html"), "utf8");
      assert.match(html, /href="#fig-nb-test">Figure 1<\/a>/);
      assert.match(html, /href="#tbl-nb-test">Table 1<\/a>/);
      assert.doesNotMatch(html, /must not run/);
    } finally {
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith("r-notebook-crossref-"));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
