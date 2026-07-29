import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { HiddenRProcess } from "../../src/Runtime/process";

const FAKE_R_PROCESS = String.raw`
const fs = require("node:fs");
let state = "missing";
let input = "";
process.on("SIGINT", () => {
  const marker = process.env.INTERRUPT_MARKER;
  if (marker) fs.writeFileSync(marker, "interrupted");
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const separator = line.indexOf(" ");
    const command = separator < 0 ? line : line.slice(0, separator);
    const argument = separator < 0 ? "" : line.slice(separator + 1);
    if (command === "init") process.stdout.write("READY " + process.pid + "\n");
    if (command === "set") state = argument;
    if (command === "write") fs.writeFileSync(argument, state);
    if (command === "exit") process.exit(9);
    newline = input.indexOf("\n");
  }
});
`;

function waitForFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(filePath), () => {
      void fsPromises.access(filePath).then(finish, () => undefined);
    });
    const finish = (): void => {
      watcher.close();
      resolve();
    };
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    void fsPromises.access(filePath).then(finish, () => undefined);
  });
}

test("keeps state in one hidden process and isolates different processes", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hidden-r-process-test-"));
  const launchOptions = async () => ({
    executable: process.execPath,
    args: ["-e", FAKE_R_PROCESS],
    cwd: directory,
    env: { ...process.env },
  });
  const firstRunningStates: boolean[] = [];
  const first = new HiddenRProcess(
    launchOptions,
    () => undefined,
    (running) => firstRunningStates.push(running)
  );
  const second = new HiddenRProcess(launchOptions, () => undefined);
  t.after(() => {
    first.dispose();
    second.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  (await first.send("set first-session")).dispose();
  (await second.send("set second-session")).dispose();
  assert.equal(first.running, true);
  assert.equal(first.processId, undefined);
  assert.deepEqual(firstRunningStates, [true]);

  const firstResult = path.join(directory, "first.txt");
  const secondResult = path.join(directory, "second.txt");
  const firstWritten = waitForFile(firstResult);
  const firstDispatch = await first.send(`write ${firstResult}`);
  await firstWritten;
  firstDispatch.dispose();
  const secondWritten = waitForFile(secondResult);
  const secondDispatch = await second.send(`write ${secondResult}`);
  await secondWritten;
  secondDispatch.dispose();

  assert.equal(await fsPromises.readFile(firstResult, "utf8"), "first-session");
  assert.equal(await fsPromises.readFile(secondResult, "utf8"), "second-session");

  const stopped = await first.send("set stopping");
  first.dispose();
  assert.deepEqual(firstRunningStates, [true, false]);
  await assert.rejects(stopped.failure, /stopped|exited/);
  stopped.dispose();
  await assert.rejects(first.send("set unavailable"), /session has closed/);

  const failure = await second.send("exit");
  await assert.rejects(failure.failure, /exited with code 9/);
  failure.dispose();
});

test("reports when an initialised R process starts and stops", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hidden-r-status-test-"));
  const runningStates: boolean[] = [];
  const hiddenProcess = new HiddenRProcess(
    async () => ({
      executable: process.execPath,
      args: ["-e", FAKE_R_PROCESS],
      cwd: directory,
      env: { ...process.env },
      initialization: {
        command: "init",
        successMarker: "READY ",
        failureMarker: "FAILED ",
      },
    }),
    () => undefined,
    (running) => runningStates.push(running)
  );
  t.after(() => {
    hiddenProcess.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  await hiddenProcess.reattach();
  assert.deepEqual(runningStates, [true]);

  const failure = await hiddenProcess.send("exit");
  await assert.rejects(failure.failure, /exited with code 9/);
  failure.dispose();
  assert.deepEqual(runningStates, [true, false]);
});

test("interrupts work without replacing the hidden process", async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hidden-r-interrupt-test-"));
  const markerPath = path.join(directory, "interrupted.txt");
  const resultPath = path.join(directory, "result.txt");
  const hiddenProcess = new HiddenRProcess(
    async () => ({
      executable: process.execPath,
      args: ["-e", FAKE_R_PROCESS],
      cwd: directory,
      env: { ...process.env, INTERRUPT_MARKER: markerPath },
      initialization: {
        command: "init",
        successMarker: "READY ",
        failureMarker: "FAILED ",
      },
    }),
    () => undefined
  );
  t.after(() => {
    hiddenProcess.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  await hiddenProcess.reattach();
  const processId = hiddenProcess.processId;
  assert.ok(processId);
  (await hiddenProcess.send("set preserved")).dispose();

  const interrupted = waitForFile(markerPath);
  hiddenProcess.interrupt();
  await interrupted;

  const written = waitForFile(resultPath);
  const dispatch = await hiddenProcess.send(`write ${resultPath}`);
  await written;
  dispatch.dispose();
  assert.equal(hiddenProcess.processId, processId);
  assert.equal(await fsPromises.readFile(resultPath, "utf8"), "preserved");
});
