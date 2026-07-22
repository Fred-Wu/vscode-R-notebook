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
  const first = new HiddenRProcess(launchOptions, () => undefined);
  const second = new HiddenRProcess(launchOptions, () => undefined);
  t.after(() => {
    first.dispose();
    second.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  (await first.send("set first-session")).dispose();
  (await second.send("set second-session")).dispose();

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
  await assert.rejects(stopped.failure, /stopped|exited/);
  stopped.dispose();
  await assert.rejects(first.send("set unavailable"), /session has closed/);

  const failure = await second.send("exit");
  await assert.rejects(failure.failure, /exited with code 9/);
  failure.dispose();
});
