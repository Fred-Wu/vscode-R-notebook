import assert from "node:assert/strict";
import test from "node:test";
import { needsPlainRCompletionProxy } from "../../src/Notebook/rCompletionSupport";

test("proxies R code cells in an R Markdown notebook", () => {
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/c:/Users/test/OneDrive - Example/test.rmd", "r"
  ), true);
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/c:/my%20folder/test.RMD", "r"
  ), true);
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/workspace/test.qmd", "r"
  ), true);
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/workspace/test.rmarkdown", "r"
  ), true);
});

test("does not alter other languages, editors or regular R files", () => {
  assert.equal(needsPlainRCompletionProxy(
    "file", "/workspace/test.rmd", "r"
  ), false);
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/workspace/test.rmd", "markdown"
  ), false);
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/workspace/test.R", "r"
  ), false);
  assert.equal(needsPlainRCompletionProxy(
    "vscode-notebook-cell", "/workspace/test.rmd.backup", "r"
  ), false);
});
