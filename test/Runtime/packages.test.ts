import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import type { NotebookPackageStatus } from "../../src/Runtime/bridge";

test("package offers coordinate libraries and report failed installs", async (t) => {
  const prompts: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  let choose = async (): Promise<string | undefined> => "Install";
  const api = {
    ProgressLocation: { Notification: 15 },
    window: {
      showInformationMessage: async (message: string) => { prompts.push(message); return choose(); },
      showErrorMessage: (message: string) => { errors.push(message); },
      withProgress: (_options: unknown, task: () => Promise<void>) => task(),
    },
  };
  const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown };
  const originalLoad = loader._load;
  loader._load = function(request, parent, isMain) {
    return request === "vscode" ? api : originalLoad.call(this, request, parent, isMain);
  };
  let Installer: typeof import("../../src/Runtime/packages").NotebookPackageInstaller;
  try { ({ NotebookPackageInstaller: Installer } = await import("../../src/Runtime/packages")); }
  finally { loader._load = originalLoad; }
  const create = () => new Installer({ appendLine: (message: string) => { output.push(message); } } as vscode.OutputChannel);

  await t.test("healthy installations do not prompt", async () => {
    await create().ensure({ notebookPackages: async () => ({ library: "/library", missing: [] }) }, () => true);
    assert.equal(prompts.length, 0);
  });

  for (const choice of ["Install", "Not Now", undefined]) {
    await t.test(`two notebooks share one offer for the same library (${choice})`, async () => {
      let resolve!: (value: string | undefined) => void;
      choose = () => new Promise((done) => { resolve = done; });
      let installs = 0;
      let missing = ["litedown", "jsonlite"];
      const bridge = { notebookPackages: async (install?: { packages: string[]; library: string }): Promise<NotebookPackageStatus> => {
        if (install) { installs++; missing = []; }
        return { library: "/project/library", missing };
      } };
      const installer = create();
      const count = prompts.length;
      const first = installer.ensure(bridge, () => true);
      const second = installer.ensure(bridge, () => true);
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(prompts.length, count + 1);
      assert.match(prompts.at(-1)!, /litedown, jsonlite/);
      assert.match(prompts.at(-1)!, /\/project\/library/);
      resolve(choice);
      await Promise.all([first, second]);
      assert.equal(installs, choice === "Install" ? 1 : 0);
    });
  }

  await t.test("install failures are reported and do not leave the library locked", async () => {
    choose = async () => "Install";
    const installer = create();
    let fails = true;
    const bridge = { notebookPackages: async (install?: { packages: string[]; library: string }) => {
      if (install && fails) throw new Error("Repository unavailable");
      return { library: "/library", missing: install ? [] : ["knitr"] };
    } };
    await installer.ensure(bridge, () => true);
    assert.match(errors.at(-1)!, /Repository unavailable/);
    assert.ok(output.some((line) => line.includes("Repository unavailable")));
    fails = false;
    const errorCount = errors.length;
    await installer.ensure(bridge, () => true);
    assert.equal(errors.length, errorCount);
  });
});
