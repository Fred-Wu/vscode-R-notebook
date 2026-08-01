import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createVscodeRAttachmentInitialization,
  isVscodeRWorkingDirectoryAccepted,
  readVscodeRSessionRequest,
  VscodeRSessionRequestWatcher,
} from "../../src/Runtime/vscodeR";

test("disables unused vscode-R integrations before initialising an inline session", () => {
  const initialization = createVscodeRAttachmentInitialization();
  const disableViewers = initialization.command.indexOf(
    "vsc.plot = FALSE,\n      vsc.use_httpgd = FALSE"
  );
  const disableRStudioApi = initialization.command.indexOf(
    "vsc.rstudioapi = FALSE"
  );
  const nullDevice = initialization.command.indexOf(
    "device = function(...) grDevices::pdf(NULL)"
  );
  const initializeVscodeR = initialization.command.indexOf("base::sys.source(init_file");

  assert.ok(disableViewers >= 0);
  assert.ok(disableRStudioApi > disableViewers);
  assert.ok(nullDevice > disableRStudioApi);
  assert.ok(initializeVscodeR > nullDevice);
});

test("matches vscode-R's workspace filtering", () => {
  const home = path.resolve("home");
  const workspace = path.resolve("workspace");

  assert.equal(isVscodeRWorkingDirectoryAccepted(home, undefined, home), true);
  assert.equal(
    isVscodeRWorkingDirectoryAccepted(path.join(home, "project"), undefined, home),
    false
  );
  assert.equal(
    isVscodeRWorkingDirectoryAccepted(path.join(workspace, "notebooks"), [workspace], home),
    true
  );
  assert.equal(
    isVscodeRWorkingDirectoryAccepted(path.resolve("other"), [workspace], home),
    false
  );
});

test("reads complete vscode-R session requests and ignores duplicate lock tokens", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "r-notebook-session-request-")
  );
  const requestPath = path.join(directory, "request.log");
  const lockPath = path.join(directory, "request.lock");
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));

  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "attach", pid: 123, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "1.000001", "utf8");

  const attached = await readVscodeRSessionRequest(directory);
  assert.deepEqual(attached, {
    lockToken: "1.000001",
    request: {
      command: "attach",
      pid: 123,
      workingDirectory: "/workspace/one",
      lockToken: "1.000001",
    },
  });
  assert.equal(
    await readVscodeRSessionRequest(directory, attached?.lockToken),
    undefined
  );

  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "detach", pid: 123, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "1.000002", "utf8");
  assert.deepEqual(await readVscodeRSessionRequest(directory, attached?.lockToken), {
    lockToken: "1.000002",
    request: {
      command: "detach",
      pid: 123,
      workingDirectory: "/workspace/one",
      lockToken: "1.000002",
    },
  });

  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "help", pid: 123, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "1.000003", "utf8");
  assert.deepEqual(await readVscodeRSessionRequest(directory, "1.000002"), {
    lockToken: "1.000003",
  });

  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "attach", pid: 0, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "1.000004", "utf8");
  assert.equal(
    await readVscodeRSessionRequest(directory, "1.000003"),
    undefined
  );
});

test("waits for the expected attachment PID from the vscode-R request files", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "r-notebook-session-ready-")
  );
  const requestPath = path.join(directory, "request.log");
  const lockPath = path.join(directory, "request.lock");
  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "attach", pid: 321, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "2.000001", "utf8");

  const requests: number[] = [];
  const watcher = new VscodeRSessionRequestWatcher(
    async (request) => {
      requests.push(request.pid);
      return true;
    },
    () => undefined,
    directory
  );
  t.after(() => {
    watcher.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  const checkpoint = watcher.attachmentCheckpoint();
  await watcher.waitForAttachment(321, checkpoint);
  await watcher.synchronize();
  assert.deepEqual(requests, [321]);

  const nextCheckpoint = watcher.attachmentCheckpoint();
  let repeatedAttachmentReady = false;
  const repeatedAttachment = watcher
    .waitForAttachment(321, nextCheckpoint)
    .then(() => {
      repeatedAttachmentReady = true;
    });
  await watcher.synchronize();
  assert.equal(repeatedAttachmentReady, false);
  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "attach", pid: 321, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "2.000002", "utf8");
  await watcher.synchronize();
  await repeatedAttachment;
  assert.deepEqual(requests, [321, 321]);
});

test("observes a replacement attach while detach handling is queued", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "r-notebook-session-restart-")
  );
  const requestPath = path.join(directory, "request.log");
  const lockPath = path.join(directory, "request.lock");
  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "detach", pid: 111, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "3.000001", "utf8");

  let releaseDetach: (() => void) | undefined;
  let detachStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    detachStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDetach = resolve;
  });
  const watcher = new VscodeRSessionRequestWatcher(
    async (request) => {
      if (request.command === "detach") {
        detachStarted?.();
        await blocked;
      }
      return true;
    },
    () => undefined,
    directory
  );
  t.after(() => {
    releaseDetach?.();
    watcher.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  const replacement = watcher.waitForAttachment(
    222,
    watcher.attachmentCheckpoint()
  );
  await started;
  await fsPromises.writeFile(
    requestPath,
    JSON.stringify({ command: "attach", pid: 222, wd: "/workspace/one" }),
    "utf8"
  );
  await fsPromises.writeFile(lockPath, "3.000002", "utf8");

  const synchronization = watcher.synchronize();
  await Promise.race([
    replacement,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("replacement attachment was blocked")), 1_000);
    }),
  ]);
  releaseDetach?.();
  await synchronization;
});
