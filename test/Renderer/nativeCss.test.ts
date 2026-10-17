import assert from "node:assert/strict";
import test from "node:test";
import { decodeEmbeddedCss, scopeNativeCssSelector } from "../../src/Renderer/nativeCss";

test("scopes regular and root selectors to the Markdown cell", () => {
  assert.equal(scopeNativeCssSelector(".cell, pre code"),
    ".r-notebook-markdown-cell .cell, .r-notebook-markdown-cell pre code");
  assert.equal(scopeNativeCssSelector("body .cell, :root"),
    ".r-notebook-markdown-cell .cell, .r-notebook-markdown-cell");
  assert.equal(scopeNativeCssSelector(":is(h1, h2) > span"),
    ".r-notebook-markdown-cell :is(h1, h2) > span");
});

test("decodes embedded native CSS without reading remote stylesheets", () => {
  assert.equal(decodeEmbeddedCss("data:text/css,.cell%7Bcolor%3Ared%7D"), ".cell{color:red}");
  assert.equal(decodeEmbeddedCss("data:text/css;base64,LmNlbGx7fQ=="), ".cell{}");
  assert.equal(decodeEmbeddedCss("https://example.org/theme.css"), undefined);
  assert.equal(decodeEmbeddedCss("data:text/css;base64,!!!"), undefined);
});
