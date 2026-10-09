import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as mail from "../src/utils/mail.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const agent = "update-test";
const seed = Buffer.alloc(32, 0x22);
const principal = { id: "kern", name: "kern", publicKey: pubkeyFromSeed(seed).toString("base64") };
let root: string;
let target: string;
let priorMailDir: string | undefined;
let verifier: ReturnType<typeof spyOn>;
const faults: Array<ReturnType<typeof spyOn>> = [];
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "existing-update-"));
  priorMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  target = join(mail.getInbox(agent).cur, "record.json");
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue(principal);
});
afterEach(() => {
  for (const fault of faults.splice(0)) fault.mockRestore();
  verifier.mockRestore();
  if (priorMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = priorMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});
async function plantPromoted() {
  const pending = join(mail.getInbox(agent).fresh, "record.json");
  const envelope = buildSignedEnvelope("kern", agent, "hello", { kern: seed });
  fs.writeFileSync(pending, JSON.stringify({ id: "record-id", from: "kern", to: agent, body: JSON.stringify(envelope) }));
  expect((await mail.promote(agent, pending)).ok).toBe(true);
  const record = JSON.parse(fs.readFileSync(target, "utf8"));
  delete record.checkedOutAt;
  delete record.checkedOutBy;
  fs.writeFileSync(target, JSON.stringify(record));
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("barrier timeout");
}

test("lease sweep updates and returns an unchanged verified record", async () => {
  await plantPromoted();
  const checked = await mail.checkMessages(agent, "consumer");
  expect(checked).toHaveLength(1);
  expect(checked[0].body).toBe("hello");
  expect(checked[0].checkedOutBy).toBe("consumer");
  expect(JSON.parse(fs.readFileSync(target, "utf8")).checkedOutAt).toBe(checked[0].checkedOutAt);
});

for (const type of ["transient", "agent", "permanent"] as const) {
  test(`nack ${type} updates the fresh existing record`, () => {
    fs.writeFileSync(target, JSON.stringify({ id: "record-id", body: "hello", read: false, bridgeSentAt: "preserve" }));
    const result = mail.nackMessage(agent, "record-id", "retry", type, "1m");
    expect(result?.nackType).toBe(type);
    expect(result?.nackReason).toBe("retry");
    const saved = type === "permanent" ? join(mail.getInbox(agent).dlq, "record.json") : target;
    expect(JSON.parse(fs.readFileSync(saved, "utf8")).bridgeSentAt).toBe("preserve");
    expect(fs.existsSync(target)).toBe(type !== "permanent");
  });
}

for (const change of ["ack", "body", "id", "lease", "receipt"]) {
  test(`lease sweep revalidates its verified snapshot after ${change}`, async () => {
    await plantPromoted();
    let verifying = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    verifier.mockImplementation(async () => { verifying = true; await barrier; return principal; });
    const checking = mail.checkMessages(agent);
    await waitFor(() => verifying);
    expect(fs.existsSync(join(mail.getInbox(agent).root, ".mail-lock"))).toBe(false);
    if (change === "ack") mail.ackMessageAtPath(target);
    else {
      const current = JSON.parse(fs.readFileSync(target, "utf8"));
      if (change === "body") current.body = "changed";
      if (change === "id") current.id = "different-id";
      if (change === "lease") { current.checkedOutAt = new Date().toISOString(); current.checkedOutBy = "another"; }
      if (change === "receipt") current.read = true;
      fs.writeFileSync(target, JSON.stringify(current));
    }
    const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
    release();
    expect(await checking).toEqual([]);
    if (before === undefined) expect(fs.existsSync(target)).toBe(false);
    else expect(fs.readFileSync(target, "utf8")).toBe(before);
  });
}

for (const operation of ["ack", "ack-id", "sent", "nack-transient", "nack-agent", "nack-permanent"]) {
  test(`${operation} writes nothing when its record vanishes`, () => {
    fs.writeFileSync(target, JSON.stringify({ id: "record-id", body: "hello", read: false }));
    const read = fs.readFileSync;
    faults.push(spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
      const result = read(...args);
      if (args[0] === target) fs.unlinkSync(target);
      return result;
    }) as typeof read));
    if (operation === "ack") expect(() => mail.ackMessageAtPath(target)).toThrow();
    else if (operation === "ack-id") expect(() => mail.ackMessage(agent, "record-id")).toThrow();
    else if (operation === "sent") expect(() => mail.setBridgeSentAtPath(target, "sent")).toThrow();
    else expect(mail.nackMessage(agent, "record-id", "retry", operation.slice(5) as any)).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(mail.getInbox(agent).cur)).toEqual([]);
    expect(fs.readdirSync(mail.getInbox(agent).dlq)).toEqual([]);
  });
}

test("helper returns gone without invoking mutate or writing", () => {
  let mutated = false;
  expect(mail.updateExistingRecord(target, (record) => { mutated = true; return record; })).toEqual({ status: "gone" });
  expect(mutated).toBe(false);
  expect(fs.readdirSync(mail.getInbox(agent).cur)).toEqual([]);
});

test("nack and ack interleaving never recreates the removed record", async () => {
  fs.writeFileSync(target, JSON.stringify({ id: "record-id", body: "hello", read: false }));
  const worker = join(root, "worker.ts");
  fs.writeFileSync(worker, `
    import { spyOn } from "bun:test";
    import * as fs from "node:fs";
    import { join } from "node:path";
    const [role, root, target, source, agent] = process.argv.slice(2);
    process.env.TPS_MAIL_DIR = root;
    const signal = (name) => fs.writeFileSync(join(root, name), "ready");
    const wait = (name) => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(join(root, name))) {
        if (Date.now() > deadline) throw new Error("barrier timeout: " + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    };
    const read = fs.readFileSync;
    let reads = 0;
    spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const result = read(...args);
      if (role === "nack" && args[0] === target && ++reads === 2) { signal("nack-read"); wait("release-nack"); }
      if (role === "ack" && String(args[0]).endsWith(".mail-lock/owner.json") && JSON.parse(String(result)).pid !== process.pid)
        signal("ack-contended");
      return result;
    });
    const mail = await import(source);
    if (role === "nack") mail.nackMessage(agent, "record-id", "retry");
    else mail.ackMessageAtPath(target);
    signal(role + "-done");
  `);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (role: string) => {
    const child = Bun.spawn([process.execPath, worker, role, root, target,
      new URL("../src/utils/mail.ts", import.meta.url).href, agent], { stdout: "pipe", stderr: "pipe" });
    children.push(child);
    return child;
  };
  try {
    const nack = spawn("nack");
    await waitFor(() => fs.existsSync(join(root, "nack-read")));
    const ack = spawn("ack");
    await waitFor(() => ["ack-done", "ack-contended"].some((name) => fs.existsSync(join(root, name))));
    fs.writeFileSync(join(root, "release-nack"), "ready");
    expect(await nack.exited).toBe(0);
    expect(await ack.exited).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});
