import assert from "node:assert/strict";
import test from "node:test";
import { splitFrontMatter, yamlFrontMatterHtml } from "../../src/markdown";

test("front matter is accessible and source remains escaped", () => {
  const source = "---\ntitle: A < B\n---\n\nBody";
  const parts = splitFrontMatter(source);
  assert.equal(parts.body, "\nBody");
  const html = yamlFrontMatterHtml(parts.frontMatter);
  assert.match(html, /<details data-r-notebook-front-matter>/);
  assert.match(html, /<summary>YAML front matter<\/summary>/);
  assert.match(html, /A &lt; B/);
  assert.doesNotMatch(html, /A < B/);
  assert.equal(yamlFrontMatterHtml(""), "");
});
