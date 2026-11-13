import assert from "node:assert/strict";
import test from "node:test";
import { changedMarkupRequiresRefresh } from "../../src/Notebook/markdownRefresh";

test("refreshes references when existing Markdown changes", () => {
  assert.equal(changedMarkupRequiresRefresh([{ cell: { kind: 1 }, document: {} }]), true);
  assert.equal(changedMarkupRequiresRefresh([{ cell: { kind: 2 }, document: {} }]), false);
  assert.equal(changedMarkupRequiresRefresh([{ cell: { kind: 1 } }]), false);
  assert.equal(changedMarkupRequiresRefresh([]), false);
});
