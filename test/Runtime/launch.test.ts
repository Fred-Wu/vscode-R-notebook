import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscode from "vscode";

test("R executable discovery failure releases the prepared attachment", async () => {
  let disposed = 0;
  const api = {
    workspace: { getWorkspaceFolder: () => undefined },
    extensions: { getExtension: () => ({
      isActive: true,
      exports: { getRExecutablePath: async () => { throw new Error("discovery failed"); } },
    }) },
  };
  const sess = { getVscodeRSessionApi: async () => ({
    prepareAttachment: async () => ({
      attachmentId: "test", command: "attach()", dispose: () => { disposed++; },
    }),
  }) };
  const loader = Module as unknown as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = loader._load;
  loader._load = function(request, parent, isMain) {
    return request === "vscode" ? api : request === "./sess" ? sess
      : originalLoad.call(this, request, parent, isMain);
  };
  let create: typeof import("../../src/Runtime/launch").createInlineRProcess;
  try { ({ createInlineRProcess: create } = await import("../../src/Runtime/launch")); }
  finally { loader._load = originalLoad; }
  const process = create({ fsPath: "/test.Rmd" } as vscode.Uri,
    { appendLine() {} } as unknown as vscode.OutputChannel, true);
  await assert.rejects(process.start(), /discovery failed/);
  await process.dispose();
  assert.equal(disposed, 1);
});
