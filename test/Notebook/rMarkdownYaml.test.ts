import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { rMarkdownFormatsExpression, rMarkdownYamlContext, rMarkdownYamlSuggestions, type RMarkdownFormats } from "../../src/Notebook/rMarkdownYaml";

const formats: RMarkdownFormats = {
  html_document: { toc: { values: [true, false] }, code_folding: { values: ["show", "hide", "none"] }, includes: {} },
  word_document: { reference_docx: {} },
};
function complete(marked: string) {
  const offset = marked.indexOf("@");
  const before = marked.slice(0, offset).split("\n");
  const context = rMarkdownYamlContext(marked.replace("@", ""), before.length - 1, before.at(-1)!.length);
  return { context, items: context ? rMarkdownYamlSuggestions(context, formats) : [] };
}
const labels = (marked: string) => complete(marked).items.map(item => item.label);

test("Rmd header keys and formats work with incomplete YAML", () => {
  assert.deepEqual(labels("---\nti@"), ["title"]);
  assert.deepEqual(labels("---\noutput: h@"), ["html_document"]);
  assert.deepEqual(labels("---\noutput:\n  w@"), ["word_document"]);
  assert.deepEqual(labels("---\noutput:\n  html_document: d@"), ["default"]);
});

test("Rmd output options follow indentation and the selected format", () => {
  assert.deepEqual(labels("---\noutput:\n  html_document:\n    t@"), ["toc"]);
  assert.deepEqual(labels("---\noutput:\n  html_document:\n    toc: true\n  word_document:\n    r@"), ["reference_docx"]);
  assert.deepEqual(labels("---\noutput:\n  rmarkdown::html_document:\n    t@"), ["toc"]);
  assert.deepEqual(labels("---\noutput:\n  html_document:\n    includes:\n      in@"), ["in_header"]);
});

test("Rmd values are typed YAML scalars", () => {
  assert.deepEqual(complete("---\noutput:\n  html_document:\n    toc: @").items.map(item => item.insertText), ["true", "false"]);
  assert.deepEqual(labels("---\noutput:\n  html_document:\n    code_folding: h@"), ["hide"]);
  assert.deepEqual(labels("---\nruntime: s@"), ["static", "shiny", "shiny_prerendered"]);
});

test("Rmd replacement preserves existing colons, values and comments", () => {
  const { context, items } = complete("---\n  \nti@tle: My title # note");
  assert.equal(context?.start, 0);
  assert.equal(context?.end, 5);
  assert.equal(items[0]?.insertText, "title");
  assert.deepEqual(labels("---\noutput:\n  html_document:\n    toc: t@rue # note"), ["true"]);
});

test("Rmd suppresses duplicates only within the current mapping", () => {
  assert.deepEqual(labels("---\ntitle: Existing\nti@\n---"), []);
  assert.deepEqual(labels("---\nti@\ntitle: Existing\n---"), []);
  assert.deepEqual(labels("---\noutput:\n  html_document:\n    toc: true\n  word_document:\n    r@"), ["reference_docx"]);
});

test("Rmd does not complete prose, comments, scalar contents or arbitrary mappings", () => {
  for (const source of [
    "Body\nti@", "---\ntitle: Test\n---\nti@", "---\n---@", "---\n# ti@",
    "---\ntitle: |\n  ti@", "---\ntitle: >-\n\n  ti@", "---\nparams:\n  ti@",
    "---\nauthor:\n  - name: Fred\n    ti@", "---\ntitle: Some ti@", "---\noutput: { h@",
  ]) assert.deepEqual(labels(source), [], source);
  assert.deepEqual(labels("---\ntitle: |\n  Scalar\nau@"), ["author"]);
});

test("installed rmarkdown supplies format fields and typed values", t => {
  const result = spawnSync(process.env.R_EXECUTABLE || "R", ["--vanilla", "--slave"], {
    input: rMarkdownFormatsExpression, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("Set R_EXECUTABLE or put R on PATH to test installed format discovery");
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(result.stdout) as RMarkdownFormats;
  assert.deepEqual(installed.html_document?.toc?.values, [true, false]);
  assert.ok(installed.html_document?.code_folding?.values?.includes("hide"));
  assert.ok(installed.word_document?.reference_docx);
  assert.ok(!installed.parse_html_notebook, "Parser functions must not appear as formats");
});
