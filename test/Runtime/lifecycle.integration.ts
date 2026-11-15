import assert from "node:assert/strict";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { HiddenRProcess, RInterruptError } from "../../src/Runtime/process";
import { RExecutionBridge, TextRenderCancelledError } from "../../src/Runtime/bridge";

test("real R interruption preserves the session and shutdown exits the process", { timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-lifecycle-"));
  const document = path.join(directory, "test.Rmd");
  const busy = path.join(directory, "busy");
  const r = new HiddenRProcess(async () => ({
    executable: process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R"),
    args: ["--vanilla", "--quiet", process.platform === "win32" ? "--ess" : "--interactive"],
    cwd: directory, env: { ...process.env },
    initialization: {
      command: 'cat("\\nNOTEBOOK_TEST_READY:", Sys.getpid(), "\\n", sep="")',
      successMarker: "NOTEBOOK_TEST_READY:", failureMarker: "NOTEBOOK_TEST_ERROR:",
    },
  }), () => undefined);
  t.signal.addEventListener("abort", () => r.dispose(), { once: true });
  const listeners = new Set<(event: unknown) => unknown>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: (event: unknown) => unknown) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
  const bridge = new RExecutionBridge(path.resolve("resources/r/execute.R"), r);
  let watcher: ReturnType<typeof watch> | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await fs.writeFile(document, "---\noutput: html_document\n---\n");
    await r.start();
    const pid = r.processId;
    assert.ok(pid);
    const started = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("R did not enter the test cell")), 30000);
      watcher = watch(directory, (_event, name) => {
        if (name?.toString() === "busy") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const execution = bridge.execute([
      "```{r}", "notebook_value <- 42L",
      `writeLines('started', ${JSON.stringify(busy.replaceAll("\\", "/"))})`,
      "repeat Sys.sleep(0.05)", "```",
    ].join("\n"), document, token);
    // Surface startup errors immediately instead of waiting for the busy marker.
    await Promise.race([started, execution.then(() => { throw new Error("Cell ended before interruption"); })]);
    token.isCancellationRequested = true;
    listeners.forEach((listener) => listener(undefined));
    assert.equal((await execution).success, false);
    const next = await bridge.execute("```{r}\nnotebook_value\n```", document, {
      ...token, isCancellationRequested: false,
    });
    assert.equal(next.success, true, next.outputs.map((output) => Buffer.from(output.data).toString()).join("\n"));
    assert.ok(next.outputs.some((output) => Buffer.from(output.data).toString().includes("42")));
    assert.equal(r.processId, pid);
    await r.dispose();
    let exited = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(exited, "Shutdown left the notebook R process alive");
  } finally {
    clearTimeout(timeout);
    watcher?.close();
    await r.dispose();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const cancellationCases = (["native text", "code cell"] as const).flatMap(operation =>
  [false, true].map(duringLoad => ({ operation, duringLoad })));
for (const { operation, duringLoad } of cancellationCases) {
  test(`${operation} cancellation ${duringLoad ? "during helper loading" : "before R accepts the request"} completes and preserves R`, { timeout: 20000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-render-cancel-"));
    const document = path.join(directory, "test.Rmd");
    const helper = path.join(directory, "slow-helper.R");
    const r = new HiddenRProcess(async () => ({
      executable: process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R"),
      args: ["--vanilla", "--quiet", process.platform === "win32" ? "--ess" : "--interactive"],
      cwd: directory, env: { ...process.env },
      initialization: {
        command: 'cat("\\nNOTEBOOK_TEST_READY:", Sys.getpid(), "\\n", sep="")',
        successMarker: "NOTEBOOK_TEST_READY:", failureMarker: "NOTEBOOK_TEST_ERROR:",
      },
    }), () => undefined);
    t.signal.addEventListener("abort", () => r.dispose(), { once: true });
    const listeners = new Set<(event: unknown) => unknown>();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: (event: unknown) => unknown) => {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
    };
    const watcher = watch(directory, (_event, name) => {
      if (duringLoad && name?.toString() === "loading") {
        token.isCancellationRequested = true;
        listeners.forEach((listener) => listener(undefined));
      }
    });
    try {
      await fs.writeFile(document, "text\n");
      await fs.writeFile(helper, `writeLines('loading', ${JSON.stringify(path.join(directory, "loading").replaceAll("\\", "/"))})\nSys.sleep(60)\n`);
      await r.start();
      const pid = r.processId;
      (await r.send("notebook_retained_value <- 42L")).dispose();
      // Hold R before dispatch to exercise cancellation before the ready marker,
      // separately from interruption inside sys.source() after acknowledgement.
      if (!duringLoad) (await r.send("Sys.sleep(0.5)")).dispose();
      const bridge = new RExecutionBridge(helper, {
        send: async (command) => {
          const dispatch = await r.send(command);
          if (!duringLoad) token.isCancellationRequested = true;
          return dispatch;
        },
        interrupt: () => r.interrupt(),
      });
      if (operation === "native text") {
        await assert.rejects(bridge.renderText([], "text\n", document, token), TextRenderCancelledError);
      } else {
        assert.deepEqual(await bridge.execute("```{r}\n42\n```", document, token), {
          success: false, outputs: [],
        });
      }
      const next = await new RExecutionBridge(path.resolve("resources/r/execute.R"), r)
        .execute("```{r}\nnotebook_retained_value\n```", document, { ...token, isCancellationRequested: false });
      assert.equal(next.success, true);
      assert.ok(next.outputs.some((output) => Buffer.from(output.data).toString().includes("42")));
      assert.equal(r.processId, pid);
    } finally {
      watcher.close();
      await r.dispose();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

for (const operation of ["native text", "code cell"] as const) {
  test(`${operation} waits for R cleanup after the result is written`, { timeout: 20000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-completion-"));
    const document = path.join(directory, "test.Rmd");
    const helper = path.join(directory, "helper.R");
    const unwound = path.join(directory, "unwound");
    const r = new HiddenRProcess(async () => ({
      executable: process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R"),
      args: ["--vanilla", "--quiet", process.platform === "win32" ? "--ess" : "--interactive"],
      cwd: directory, env: { ...process.env },
    }), () => undefined);
    t.signal.addEventListener("abort", () => r.dispose(), { once: true });
    try {
      await fs.writeFile(document, "text\n");
      await fs.writeFile(helper, [
        "r_notebook_execute <- r_notebook_render_text <- function(output_dir, ...) {",
        `  on.exit({ Sys.sleep(0.3); writeLines('unwound', ${JSON.stringify(unwound.replaceAll("\\", "/"))}) })`,
        "  writeLines('<p>rendered</p>', file.path(output_dir, 'result.html'))",
        "  writeLines('true', file.path(output_dir, 'done'))",
        "}",
      ].join("\n"));
      const bridge = new RExecutionBridge(helper, r);
      if (operation === "native text") {
        assert.match(await bridge.renderText([], "text\n", document), /rendered/);
      } else {
        assert.equal((await bridge.execute("```{r}\n42\n```", document, {
          isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
        })).success, true);
      }
      assert.equal((await fs.readFile(unwound, "utf8")).trim(), "unwound",
        "The bridge returned before R finished unwinding the request");
    } finally {
      await r.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test(`${operation} stops R before reporting a failed interruption`, { timeout: 20000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-interrupt-failure-"));
    const document = path.join(directory, "test.Rmd");
    const helper = path.join(directory, "helper.R");
    let cancel!: () => void;
    let requestPath = "";
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: (event: unknown) => unknown) => {
        cancel = () => { listener(undefined); };
        return { dispose() {} };
      },
    };
    const r = new HiddenRProcess(async () => ({
      executable: process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R"),
      args: ["--vanilla", "--quiet", process.platform === "win32" ? "--ess" : "--interactive"],
      cwd: directory, env: { ...process.env },
      interrupt: async () => { throw new Error("test interrupt failure"); },
    }), () => undefined);
    t.signal.addEventListener("abort", () => r.dispose(), { once: true });
    const watcher = watch(directory, (_event, name) => {
      if (name?.toString() === "busy") {
        token.isCancellationRequested = true;
        cancel?.();
      }
    });
    try {
      await fs.writeFile(document, "text\n");
      await fs.writeFile(helper, [
        `writeLines('busy', ${JSON.stringify(path.join(directory, "busy").replaceAll("\\", "/"))})`,
        "repeat Sys.sleep(0.05)",
      ].join("\n"));
      const bridge = new RExecutionBridge(helper, {
        send: (command) => {
          requestPath = JSON.parse(command.match(/^base::source\(("(?:\\.|[^"])*")/)![1]!);
          return r.send(command);
        },
        interrupt: () => r.interrupt(),
      });
      const execution = operation === "native text"
        ? bridge.renderText([], "text\n", document, token)
        : bridge.execute("```{r}\n42\n```", document, token);
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error instanceof RInterruptError);
        assert.match(error.message, /test interrupt failure/);
        assert.match(error.message, /session was stopped/);
        return true;
      });
      assert.equal(r.running, false);
      await assert.rejects(r.send("42"), /session has closed/);
      await assert.rejects(fs.access(path.dirname(requestPath)), { code: "ENOENT" });
    } finally {
      watcher.close();
      await r.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
