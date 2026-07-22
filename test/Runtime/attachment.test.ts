import assert from "node:assert/strict";
import test from "node:test";
import {
  InlineAttachmentCoordinator,
  type AttachableInlineProcess,
} from "../../src/Runtime/attachment";

class TestInlineProcess implements AttachableInlineProcess {
  attachCount = 0;
  repairCount = 0;
  nextProcessId: number | undefined;
  failNextRepair = false;

  constructor(public processId: number | undefined) {}

  async reattach(): Promise<number> {
    this.attachCount += 1;
    if (this.processId === undefined) {
      this.processId = this.nextProcessId;
    }
    if (this.processId === undefined) {
      throw new Error("process exited");
    }
    return this.processId;
  }

  async reattachExisting(expectedProcessId: number): Promise<number> {
    this.repairCount += 1;
    if (this.failNextRepair) {
      this.failNextRepair = false;
      this.processId = undefined;
      throw new Error("process exited");
    }
    assert.equal(this.processId, expectedProcessId);
    return expectedProcessId;
  }
}

const workspace = process.cwd();

function request(command: "attach" | "detach", pid: number) {
  return {
    command,
    pid,
    workingDirectory: workspace,
    lockToken: `${command}-${pid}`,
  } as const;
}

const synchronize = (lockToken: string) => async () => lockToken;

test("reattaches only for process changes and repairs a late foreign detach", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const first = new TestInlineProcess(101);
  const second = new TestInlineProcess(202);

  await attachment.ensureAttached(first);
  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 1);

  await attachment.handleSessionRequest(request("attach", 900));
  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 2);

  await attachment.handleSessionRequest(request("detach", 900));
  assert.equal(first.repairCount, 1);

  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 2);

  attachment.beginExecution(first);
  await attachment.handleSessionRequest(request("detach", 901));
  assert.equal(first.repairCount, 1);
  await attachment.endExecution(first, synchronize("detach-901"));
  assert.equal(first.repairCount, 2);

  attachment.beginExecution(first);
  await attachment.handleSessionRequest(request("detach", 902));
  await attachment.handleSessionRequest(request("detach", 101));
  await attachment.endExecution(first, synchronize("detach-902"));
  assert.equal(first.repairCount, 2);

  await attachment.ensureAttached(first);
  attachment.beginExecution(first);
  await attachment.handleSessionRequest(request("detach", 903));
  await attachment.handleSessionRequest(request("attach", 900));
  await attachment.endExecution(first, synchronize("attach-900"));
  assert.equal(first.repairCount, 2);

  await attachment.ensureAttached(first);
  attachment.beginExecution(first);
  await attachment.handleSessionRequest(request("detach", 904));
  attachment.beginExecution(second);
  await attachment.ensureAttached(second);
  await attachment.endExecution(first, synchronize("detach-904"));
  await attachment.endExecution(second, synchronize("detach-904"));
  assert.equal(first.repairCount, 2);
  assert.equal(second.attachCount, 1);

  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 5);

  await attachment.handleSessionRequest(request("detach", 101));
  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 6);

  first.processId = 303;
  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 7);

  first.failNextRepair = true;
  await assert.rejects(
    attachment.handleSessionRequest(request("detach", 905)),
    /process exited/
  );
  assert.equal(first.attachCount, 7);
  first.nextProcessId = 404;
  await attachment.ensureAttached(first);
  assert.equal(first.attachCount, 8);
  assert.equal(first.processId, 404);
});

test("a newer unobserved request cancels a deferred repair", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const process = new TestInlineProcess(501);

  await attachment.ensureAttached(process);
  attachment.beginExecution(process);
  await attachment.handleSessionRequest(request("detach", 700));
  await attachment.endExecution(process, synchronize("attach-800"));

  assert.equal(process.repairCount, 0);
  await attachment.ensureAttached(process);
  assert.equal(process.attachCount, 2);
});

test("the latest foreign detach preserves a deferred repair", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const process = new TestInlineProcess(501);

  await attachment.ensureAttached(process);
  attachment.beginExecution(process);
  await attachment.handleSessionRequest(request("detach", 700));
  await attachment.handleSessionRequest(request("detach", 701));
  await attachment.endExecution(process, synchronize("detach-701"));

  assert.equal(process.repairCount, 1);
  assert.equal(process.attachCount, 1);
});

test("forgetting a stopped process cancels its deferred repair", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const process = new TestInlineProcess(501);

  await attachment.ensureAttached(process);
  attachment.beginExecution(process);
  await attachment.handleSessionRequest(request("detach", 700));
  attachment.forget(process);
  await attachment.endExecution(process, synchronize("detach-700"));

  assert.equal(process.repairCount, 0);
});

test("selecting a notebook restores its existing process", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const first = new TestInlineProcess(101);
  const second = new TestInlineProcess(202);

  await attachment.ensureAttached(first);
  await attachment.ensureAttached(second);
  await attachment.select(first);

  assert.equal(first.attachCount, 1);
  assert.equal(first.repairCount, 1);
  assert.equal(second.attachCount, 1);
});

test("running an inactive notebook restores the selected notebook afterward", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const selected = new TestInlineProcess(101);
  const inactive = new TestInlineProcess(202);

  await attachment.ensureAttached(selected);
  attachment.beginExecution(inactive);
  await attachment.ensureAttached(inactive, false);
  await attachment.endExecution(inactive, synchronize("attach-202"));

  assert.equal(selected.repairCount, 1);
  assert.equal(inactive.attachCount, 1);
});

test("a closing console restores the selected notebook process", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const first = new TestInlineProcess(101);
  const second = new TestInlineProcess(202);

  await attachment.ensureAttached(first);
  await attachment.ensureAttached(second);
  await attachment.select(first);
  await attachment.expectConsole(first);
  await attachment.handleSessionRequest(request("attach", 900));
  await attachment.select(second);
  await attachment.expectConsole(second);
  await attachment.handleSessionRequest(request("attach", 900));
  await attachment.handleSessionRequest(request("detach", 900));

  assert.equal(first.repairCount, 1);
  assert.equal(second.attachCount, 1);
  assert.equal(second.repairCount, 2);
});

test("a directly opened console preserves and restores the selected notebook", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const process = new TestInlineProcess(101);

  await attachment.ensureAttached(process);
  await attachment.observeConsole();
  await attachment.restoreAfterConsole();

  assert.equal(process.attachCount, 1);
  assert.equal(process.repairCount, 1);
});

test("alternating inline and console execution restores each attachment", async () => {
  const attachment = new InlineAttachmentCoordinator();
  const inline = new TestInlineProcess(101);

  await attachment.ensureAttached(inline);
  await attachment.expectConsole(inline);
  await attachment.handleSessionRequest(request("attach", 900));

  await attachment.ensureAttached(inline);
  assert.equal(inline.attachCount, 2);

  await attachment.expectConsole(inline);
  await attachment.handleSessionRequest(request("attach", 900));
  await attachment.restoreAfterConsole();

  assert.equal(inline.repairCount, 1);
  assert.equal(inline.attachCount, 2);
});

test("execution attachment waits for the expected file-protocol PID", async () => {
  let confirm: (() => void) | undefined;
  const attachment = new InlineAttachmentCoordinator(() => {
    return async (processId) => {
      assert.equal(processId, 101);
      await new Promise<void>((resolve) => {
        confirm = resolve;
      });
    };
  });
  const process = new TestInlineProcess(101);
  let attached = false;

  const pending = attachment.ensureAttached(process).then(() => {
    attached = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attached, false);
  assert.ok(confirm);
  confirm();
  await pending;
  assert.equal(attached, true);
});
