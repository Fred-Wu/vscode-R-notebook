import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import { RExecutionBridge } from "../../src/Runtime/bridge";
import type { InlineDispatch, InlineRTransport } from "../../src/Runtime/process";

const neverCancelled = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as vscode.CancellationToken;

const alreadyCancelled = {
  isCancellationRequested: true,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as vscode.CancellationToken;

function rStringArgument(source: string, name: string): string {
  const match = source.match(new RegExp(`${name} = ("(?:\\\\.|[^"])*")`));
  assert.ok(match?.[1], `missing ${name} in R request`);
  return JSON.parse(match[1]) as string;
}

class TestRTransport implements InlineRTransport {
  readonly requests: string[] = [];

  async send(command: string): Promise<InlineDispatch> {
    const sourceMatch = command.match(
      /^base::source\(("(?:\\.|[^"])*"), echo = FALSE\)$/
    );
    assert.ok(sourceMatch?.[1], "bridge did not send an R source command");
    const requestPath = JSON.parse(sourceMatch[1]) as string;
    const request = await fsPromises.readFile(requestPath, "utf8");
    this.requests.push(request);

    const outputDirectory = rStringArgument(request, "output_dir");
    await fsPromises.writeFile(
      path.join(outputDirectory, "result.txt"),
      String(40 + this.requests.length),
      "utf8"
    );
    await fsPromises.writeFile(
      path.join(outputDirectory, "000001.meta"),
      "kind: display\nmime: text/plain\nfile: result.txt\n",
      "utf8"
    );
    await fsPromises.writeFile(path.join(outputDirectory, "done"), "true\n", "utf8");

    return {
      failure: new Promise<never>(() => undefined),
      dispose: () => undefined,
    };
  }

  async interrupt(): Promise<void> {}
}

test("the bridge sends an R request and reads its result", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "r-notebook-bridge-test-")
  );
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));

  const documentPath = path.join(directory, "notebook.Rmd");
  await fsPromises.writeFile(documentPath, "---\noutput: html_document\n---\n", "utf8");

  const transport = new TestRTransport();
  const helperPath = path.resolve("resources", "r", "execute.R");
  const bridge = new RExecutionBridge(helperPath, transport);
  const first = await bridge.execute(
    "```{r}\nvalue <- 41\nvalue\n```",
    documentPath,
    neverCancelled
  );
  const second = await bridge.execute(
    "```{r}\nvalue + 1\n```",
    documentPath,
    neverCancelled
  );

  assert.equal(first.success, true);
  assert.equal(Buffer.from(first.outputs[0]?.data ?? []).toString("utf8"), "41");
  assert.equal(Buffer.from(second.outputs[0]?.data ?? []).toString("utf8"), "42");
  assert.match(transport.requests[0] ?? "", /r_notebook_execute\(/);
  assert.equal(rStringArgument(transport.requests[0] ?? "", "document_path"), documentPath);

  const cancelled = await bridge.execute(
    "```{r}\nstop('not run')\n```",
    documentPath,
    alreadyCancelled
  );
  assert.deepEqual(cancelled, { success: false, outputs: [] });
  assert.equal(transport.requests.length, 2);
});

test("streams published previews before the final done marker", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "r-notebook-stream-test-"));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, "stream.Rmd");
  await fsPromises.writeFile(documentPath, "```{r}\nprint(1)\n```\n");
  let release!: () => void;
  const completed = new Promise<void>((resolve) => { release = resolve; });
  class StreamingTransport implements InlineRTransport {
    async send(command: string): Promise<InlineDispatch> {
      const match = command.match(/^base::source\(("(?:\\\\.|[^"])*"), echo = FALSE\)$/);
      assert.ok(match?.[1]);
      const request = await fsPromises.readFile(JSON.parse(match[1]) as string, "utf8");
      const outputDir = rStringArgument(request, "output_dir");
      await fsPromises.writeFile(path.join(outputDir, "p000001.txt"), "partial");
      await fsPromises.writeFile(path.join(outputDir, "p000001.meta"),
        "kind: display\nmime: text/plain\nfile: p000001.txt\n");
      void completed.then(async () => {
        await fsPromises.writeFile(path.join(outputDir, "000001.txt"), "final");
        await fsPromises.writeFile(path.join(outputDir, "000001.meta"),
          "kind: display\nmime: text/plain\nfile: 000001.txt\n");
        await fsPromises.writeFile(path.join(outputDir, "done"), "true\n");
      });
      return { failure: new Promise<never>(() => undefined), dispose() {} };
    }
    async interrupt(): Promise<void> {}
  }
  const previews: string[] = [];
  const bridge = new RExecutionBridge(path.resolve("resources/r/execute.R"), new StreamingTransport());
  const running = bridge.execute("```{r}\nprint(1)\n```", documentPath,
    neverCancelled, undefined, async (output) => {
      previews.push(Buffer.from(output.data).toString("utf8"));
      release();
    });
  const result = await running;
  assert.deepEqual(previews, ["partial"]);
  assert.equal(Buffer.from(result.outputs[0]?.data ?? []).toString("utf8"), "final");
});
