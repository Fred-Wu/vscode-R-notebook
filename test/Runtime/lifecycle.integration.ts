import assert from "node:assert/strict";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { HiddenRProcess } from "../../src/Runtime/process";
import { RExecutionBridge } from "../../src/Runtime/bridge";

test("real R interruption preserves the session and shutdown exits the process", { timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-lifecycle-"));
  const document = path.join(directory, "test.Rmd");
  const busy = path.join(directory, "busy");
  const r = new HiddenRProcess(async () => ({
    executable: process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R"),
    args: ["--vanilla", "--quiet", process.platform === "win32" ? "--ess" : "--interactive"],
    cwd: directory, env: { ...process.env },
    initialization: {
      command: 'cat("NOTEBOOK_TEST_READY:", Sys.getpid(), "\\n", sep="")',
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
