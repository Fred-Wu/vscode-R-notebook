/* Optional native Quarto integration test. Run with node --test; skipped if unavailable. */
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const quarto = process.env.QUARTO_PATH || "quarto";
const available = spawnSync(quarto, ["--version"], { encoding: "utf8" }).status === 0;

test("Quarto resolves cross-references to non-executable notebook figure placeholders",
  { skip: !available && "Quarto is not installed" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r-notebook-crossref-"));
    try {
      const qmd = [
        "---",
        "title: Reference validation",
        "format: html",
        "---",
        "",
        "::: {#fig-nb-test fig-cap=\"A test figure\"}",
        ":::",
        "",
        "See @fig-nb-test.",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "test.qmd"), qmd);
      execFileSync(quarto,
        ["render", "test.qmd", "--to", "html", "--no-execute", "--quiet"],
        { cwd: dir, encoding: "utf8" });
      const html = fs.readFileSync(path.join(dir, "test.html"), "utf8");
      assert.match(html, /fig-nb-test/);
      assert.doesNotMatch(html, /\?@fig-nb-test|<span class="citeproc-not-found"/);
      assert.match(html, /href="#fig-nb-test"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
