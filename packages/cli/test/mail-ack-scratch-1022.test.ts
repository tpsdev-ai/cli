import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import * as mail from "../src/utils/mail.js";
import {
  WORKER_OWNER_WATCH_SCRIPT,
  ownerAwareGateWaitScript,
  spawnWatchedWorker,
  stopChild,
  waitForChildExit,
} from "../../../test/helpers/live-process.js";

afterEach(() => {
  mock.restore();
});

const agent = "scratch-test";
let root: string;
let target: string;
let priorMailDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "ack-scratch-"));
  priorMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  target = join(mail.getInbox(agent).cur, "record.json");
  fs.writeFileSync(target, JSON.stringify({ id: "record-id", body: "hello", read: false }));
});

afterEach(() => {
  if (priorMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = priorMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function scratchName(): string {
  return `.ack-${randomUUID()}.tmp`;
}

function isScratchName(name: string): boolean {
  return /^\.ack-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name);
}

test("a failed ack scratch removal is reported once with its path and code", () => {
  const warnings: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  const remove = fs.rmSync;
  let scratchPath: string | undefined;
  const fault = spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof remove>) => {
    if (typeof args[0] === "string" && isScratchName(basename(args[0]))) {
      scratchPath = args[0];
      throw Object.assign(new Error("removal refused"), { code: "EBUSY" });
    }
    return remove(...args);
  }) as typeof remove);
  try {
    expect(mail.ackMessageAtPath(target).read).toBe(true);
  } finally {
    fault.mockRestore();
    warn.mockRestore();
  }

  expect(scratchPath).toBeDefined();
  const reports = warnings.filter((line) => line.includes(scratchPath!));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("EBUSY");
});

test("the next ack in the directory removes and reports a leftover scratch", () => {
  const inbox = mail.getInbox(agent);
  const leftover = join(inbox.cur, scratchName());
  fs.writeFileSync(leftover, "{ partial");
  const other = join(inbox.cur, scratchName());
  fs.writeFileSync(other, "{ partial");

  const warnings: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    mail.ackMessageAtPath(target);
  } finally {
    warn.mockRestore();
  }

  expect(fs.existsSync(leftover)).toBe(false);
  expect(fs.existsSync(other)).toBe(false);
  for (const path of [leftover, other]) {
    expect(warnings.filter((line) => line.includes(path))).toHaveLength(1);
  }
});

test("a record and non-scratch dotfiles in the directory are never removed", () => {
  const inbox = mail.getInbox(agent);
  const record = join(inbox.cur, "other.json");
  fs.writeFileSync(record, JSON.stringify({ id: "other-id", body: "keep", read: false }));
  const dotfile = join(inbox.cur, ".x.json");
  fs.writeFileSync(dotfile, "{ not mail");
  const nearMiss = join(inbox.cur, ".ack-not-a-uuid.tmp");
  fs.writeFileSync(nearMiss, "{ not a scratch");
  const suffixed = join(inbox.cur, `${scratchName()}.bak`);
  fs.writeFileSync(suffixed, "{ not a scratch");
  const leftover = join(inbox.cur, scratchName());
  fs.writeFileSync(leftover, "{ partial");

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    mail.ackMessageAtPath(target);
  } finally {
    warn.mockRestore();
  }

  expect(fs.readFileSync(record, "utf8")).toBe(JSON.stringify({ id: "other-id", body: "keep", read: false }));
  expect(fs.readFileSync(dotfile, "utf8")).toBe("{ not mail");
  expect(fs.readFileSync(nearMiss, "utf8")).toBe("{ not a scratch");
  expect(fs.readFileSync(suffixed, "utf8")).toBe("{ not a scratch");
  expect(fs.existsSync(leftover)).toBe(false);
});

test("concurrent acks of one record produce one ack and no leftover scratch", async () => {
  const worker = join(root, "ack-worker.ts");
  fs.writeFileSync(worker, `
    import * as fs from "node:fs";
    import { join } from "node:path";
    ${WORKER_OWNER_WATCH_SCRIPT}
    const [role, root, target, source] = process.argv.slice(2);
    process.env.TPS_MAIL_DIR = root;
    const signal = (name) => fs.writeFileSync(join(root, name), "ready");
    ${ownerAwareGateWaitScript()}
    const mail = await import(source);
    signal(role + "-ready");
    wait("go");
    try {
      mail.ackMessageAtPath(target);
      signal(role + "-acked");
    } catch (err) {
      signal(role + (String(err?.message).includes("mail record gone") ? "-gone" : "-error"));
    }
    process.exit(0);
  `);
  const source = new URL("../src/utils/mail.ts", import.meta.url).href;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    for (const role of ["a", "b"]) {
      children.push(spawnWatchedWorker(worker, [role, root, target, source]));
    }
    for (const role of ["a", "b"]) {
      await waitFor(() => fs.existsSync(join(root, `${role}-ready`)));
    }
    fs.writeFileSync(join(root, "go"), "ready");
    for (const child of children) expect(await waitForChildExit(child, 10_000)).toBe(0);

    const outcomes = fs.readdirSync(root).filter((name) => name.endsWith("-acked") || name.endsWith("-gone") || name.endsWith("-error"));
    expect(outcomes.filter((name) => name.endsWith("-acked"))).toHaveLength(1);
    expect(outcomes.filter((name) => name.endsWith("-gone"))).toHaveLength(1);
    expect(outcomes.filter((name) => name.endsWith("-error"))).toEqual([]);
    const inbox = mail.getInbox(agent);
    expect(fs.readdirSync(inbox.cur)).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  } finally {
    await Promise.all(children.map((child) => stopChild(child)));
  }
}, 20_000);

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("barrier timeout");
}
