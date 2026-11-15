import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import Module from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

test("language service owns processes throughout startup and shutdown", { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-lsp-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let mode = "connecting";
  let script = "";
  let ready!: () => void;
  let stopCalls = 0;
  const logs: string[] = [];
  const subscription = () => ({ dispose() {} });
  const uri = { fsPath: path.join(directory, "test.Rmd"), scheme: "file", toString: () => "file:///test.Rmd" };
  const notebook = { uri, notebookType: "r-notebook", isClosed: false, getCells: () => [] };
  class TabInputNotebook { notebookType = "r-notebook"; uri = uri; }
  const api = {
    Uri: { file: (fsPath: string) => ({ fsPath }) }, TabInputNotebook,
    extensions: { getExtension: () => ({ isActive: true, exports: {
      getRExecutablePath: async () => process.execPath,
    } }) },
    workspace: {
      isTrusted: true, notebookDocuments: [notebook],
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "lsp.args" ? [script] : fallback }),
      onDidOpenNotebookDocument: subscription, onDidChangeNotebookDocument: subscription,
      onDidCloseNotebookDocument: subscription, onDidGrantWorkspaceTrust: subscription,
      onDidChangeConfiguration: subscription,
    },
    window: {
      createOutputChannel: () => ({ append() {}, appendLine: (line: string) => logs.push(line), dispose() {} }),
      tabGroups: { all: [{ tabs: [{ input: new TabInputNotebook() }] }], onDidChangeTabs: subscription },
    },
  };
  const replacements: Record<string, unknown> = {
    vscode: api,
    "../Runtime/launch": { resolveRExecutable: () => process.execPath },
    "vscode-languageclient/node": {
      CloseAction: { DoNotRestart: 0 }, ErrorAction: { Continue: 0 },
      LanguageClient: class {
        private started = false;
        constructor(_id: string, _name: string, private readonly connect: () => Promise<{ reader: net.Socket }>) {}
        async start() {
          const { reader } = await this.connect();
          if (mode === "failed") throw new Error("Expected initialization failure");
          if (mode === "initializing") {
            const closed = new Promise<never>((_resolve, reject) => reader.once("close", () => reject(new Error("Transport closed"))));
            ready();
            await closed;
          }
          this.started = true;
          ready();
        }
        needsStop() { return this.started; }
        async stop() { stopCalls++; this.started = false; }
      },
    },
  };
  const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown };
  const originalLoad = loader._load;
  loader._load = function(request, parent, isMain) {
    return replacements[request] ?? originalLoad.call(this, request, parent, isMain);
  };
  let Service: typeof import("../../src/Notebook/languageService").RNotebookLanguageService;
  try { ({ RNotebookLanguageService: Service } = await import("../../src/Notebook/languageService")); }
  finally { loader._load = originalLoad; }

  for (const phase of ["connecting", "initializing", "ready", "failed"]) {
    await t.test(`shutdown during ${phase} waits for the process tree`, async () => {
      mode = phase;
      stopCalls = 0;
      logs.length = 0;
      const connected = new Promise<void>((resolve) => { ready = resolve; });
      const pidFile = path.join(directory, `${phase}.json`);
      script = path.join(directory, `${phase}.cjs`);
      await fs.writeFile(script, `
        const fs = require('node:fs');
        const child = require('node:child_process').spawn(process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
        ${phase === "connecting" ? "" : "require('node:net').createConnection({ port: Number(process.env.R_NOTEBOOK_LSP_PORT), host: '127.0.0.1' });"}
        setInterval(() => {}, 1000);
      `);
      const service = new Service("unused.R");
      let pids: number[] = [];
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          try { pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as number[]; break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
        }
        assert.equal(pids.length, 2, "Language server did not start");
        if (phase === "initializing" || phase === "ready") await connected;
        if (phase === "failed") {
          // Startup failure itself must clean up, without waiting for stop().
          for (let attempt = 0; attempt < 200 && !logs.some(line => line.includes("Expected initialization failure")); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(logs.some(line => line.includes("Expected initialization failure")));
        } else {
          await Promise.all([service.stop(), service.stop()]);
        }
        assert.equal(stopCalls, phase === "ready" ? 1 : 0);
        // A killed descendant may briefly remain until the OS reaps it.
        for (const pid of pids) {
          let exited = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try { process.kill(pid, 0); }
            catch (error) {
              assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
              exited = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(exited, `Process ${pid} survived ${phase} shutdown`);
        }
      } finally {
        await service.stop();
        for (const pid of pids) {
          try { process.kill(pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
    });
  }
});
