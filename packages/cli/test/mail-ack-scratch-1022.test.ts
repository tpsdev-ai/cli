import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
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

function makeOld(path: string, now = Date.now()): void {
  const when = new Date(now - 24 * 60 * 60 * 1000);
  fs.utimesSync(path, when, when);
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
    expect(mail.ackMessageAtPath(target, mail.getInbox(agent).root).read).toBe(true);
  } finally {
    fault.mockRestore();
    warn.mockRestore();
  }

  expect(scratchPath).toBeDefined();
  const reports = warnings.filter((line) => line.includes(scratchPath!));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("EBUSY");
});

test("the first ack in the directory removes and reports leftover scratch", () => {
  const inbox = mail.getInbox(agent);
  const leftover = join(inbox.cur, scratchName());
  fs.writeFileSync(leftover, "{ partial");
  makeOld(leftover);
  const other = join(inbox.cur, scratchName());
  fs.writeFileSync(other, "{ partial");
  makeOld(other);

  const warnings: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    mail.ackMessageAtPath(target, mail.getInbox(agent).root);
  } finally {
    warn.mockRestore();
  }

  expect(fs.existsSync(leftover)).toBe(false);
  expect(fs.existsSync(other)).toBe(false);
  for (const path of [leftover, other]) {
    expect(warnings.filter((line) => line.includes(path))).toHaveLength(1);
  }
});

test("the sweep preserves records and non-scratch dotfiles", () => {
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
  makeOld(leftover);

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    mail.ackMessageAtPath(target, mail.getInbox(agent).root);
  } finally {
    warn.mockRestore();
  }

  expect(fs.readFileSync(record, "utf8")).toBe(JSON.stringify({ id: "other-id", body: "keep", read: false }));
  expect(fs.readFileSync(dotfile, "utf8")).toBe("{ not mail");
  expect(fs.readFileSync(nearMiss, "utf8")).toBe("{ not a scratch");
  expect(fs.readFileSync(suffixed, "utf8")).toBe("{ not a scratch");
  expect(fs.existsSync(leftover)).toBe(false);
});

test("acks share a directory sweep until the interval expires", () => {
  const base = Date.parse("2026-01-01T00:00:00Z");
  let now = base;
  const restoreClock = patchShared(mail.mailAckScratchTestHooks, "now", () => now);
  try {
    const cur = mail.getInbox(agent).cur;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    mail.ackMessageAtPath(target, mail.getInbox(agent).root);
    const leftover = join(cur, scratchName());
    fs.writeFileSync(leftover, "partial");
    makeOld(leftover, base);
    const ack = (path: string) => {
      fs.writeFileSync(path, JSON.stringify({ id: "bounded", body: "hello", read: false }));
      expect(mail.ackMessageAtPath(path, dirname(dirname(path))).read).toBe(true);
    };
    for (let i = 0; i < 10; i++) ack(join(cur, `record-${i}.json`));
    now = base + 10 * 60 * 1000 - 1;
    ack(target);
    expect(fs.existsSync(leftover)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const otherDir = join(root, "other", "cur");
    fs.mkdirSync(otherDir, { recursive: true });
    const otherLeftover = join(otherDir, scratchName());
    fs.writeFileSync(otherLeftover, "partial");
    makeOld(otherLeftover, base);
    ack(join(otherDir, "record.json"));
    expect(fs.existsSync(otherLeftover)).toBe(false);
    expect(fs.existsSync(leftover)).toBe(true);
    now = base + 10 * 60 * 1000;
    ack(target);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(warn.mock.calls.filter(([line]) => String(line).includes(leftover))).toHaveLength(1);
  } finally {
    restoreClock();
  }
});

test("a failed leftover sweep warns with path and code without failing the ack", () => {
  const leftover = join(mail.getInbox(agent).cur, scratchName());
  fs.writeFileSync(leftover, "partial");
  makeOld(leftover);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const remove = fs.rmSync;
  spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof remove>) => {
    if (args[0] === leftover) throw Object.assign(new Error("removal refused"), { code: "EBUSY" });
    return remove(...args);
  }) as typeof remove);
  const ack = mail.ackMessageAtPath(target, mail.getInbox(agent).root);
  expect(ack.read).toBe(true);
  expect(ack.ackedAt).toBeDefined();
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.existsSync(leftover)).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain(leftover);
  expect(warn.mock.calls[0][0]).toContain("EBUSY");
});

test("distinct records ack across processes without sweeping a live scratch", async () => {
  const iterations = 25;
  const cur = mail.getInbox(agent).cur;
  for (let i = 0; i < iterations; i++) {
    for (const role of ["a", "b"]) {
      fs.writeFileSync(join(cur, `${role}-${i}.json`), JSON.stringify({ id: `${role}-${i}`, body: "hello", read: false }));
    }
  }
  const worker = join(root, "distinct-worker.ts");
  fs.writeFileSync(worker, `
    import * as fs from "node:fs";
    import { dirname, join } from "node:path";
    import { spyOn } from "bun:test";
    ${WORKER_OWNER_WATCH_SCRIPT}
    const [role, root, cur, source, count] = process.argv.slice(2);
    process.env.TPS_MAIL_DIR = root;
    const signal = (name) => fs.writeFileSync(join(root, name), "ready");
    ${ownerAwareGateWaitScript()}
    const mail = await import(source);
    let iteration = 0;
    mail.mailAckScratchTestHooks.now = () => iteration * 10 * 60 * 1000;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    const sync = fs.fsyncSync;
    if (role === "a") spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      sync(fd);
      signal("live-" + iteration);
      wait("release-" + iteration);
    });
    else {
      const stat = fs.lstatSync;
      spyOn(fs, "lstatSync").mockImplementation((...args) => {
        const result = stat(...args);
        if (String(args[0]).endsWith("/.mail-lock")) signal("contended-" + iteration);
        return result;
      });
    }
    const results = [];
    signal(role + "-ready");
    for (; iteration < Number(count); iteration++) {
      wait(role + "-go-" + iteration);
      results.push(mail.ackMessageAtPath(join(cur, role + "-" + iteration + ".json"), dirname(cur)));
      signal(role + "-done-" + iteration);
    }
    fs.writeFileSync(join(root, role + "-results.json"), JSON.stringify({results, warnings}));
    process.exit(0);
  `);
  const source = new URL("../src/utils/mail.ts", import.meta.url).href;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const signal = (name: string) => fs.writeFileSync(join(root, name), "ready");
  const wait = (name: string) => waitFor(() => fs.existsSync(join(root, name)));
  try {
    for (const role of ["a", "b"]) children.push(spawnWatchedWorker(worker, [role, root, cur, source, String(iterations)]));
    for (const role of ["a", "b"]) await wait(`${role}-ready`);
    for (let i = 0; i < iterations; i++) {
      signal(`a-go-${i}`);
      await wait(`live-${i}`);
      expect(fs.readdirSync(cur).filter(isScratchName)).toHaveLength(1);
      signal(`b-go-${i}`);
      await wait(`contended-${i}`);
      expect(fs.readdirSync(cur).filter(isScratchName)).toHaveLength(1);
      signal(`release-${i}`);
      for (const role of ["a", "b"]) await wait(`${role}-done-${i}`);
    }
    for (const child of children) expect(await waitForChildExit(child, 10_000)).toBe(0);
    for (const role of ["a", "b"]) {
      const { results, warnings } = JSON.parse(fs.readFileSync(join(root, `${role}-results.json`), "utf8"));
      expect(warnings).toEqual([]);
      expect(results).toHaveLength(iterations);
      for (let i = 0; i < iterations; i++) {
        expect(results[i].id).toBe(`${role}-${i}`);
        expect(results[i].read).toBe(true);
        expect(results[i].ackedAt).toBeDefined();
        expect(fs.existsSync(join(cur, `${role}-${i}.json`))).toBe(false);
      }
    }
    expect(fs.readdirSync(cur).filter(isScratchName)).toEqual([]);
  } finally {
    await Promise.all(children.map((child) => stopChild(child)));
  }
}, 30_000);

test("concurrent acks of one record produce one ack and no leftover scratch", async () => {
  const worker = join(root, "ack-worker.ts");
  fs.writeFileSync(worker, `
    import * as fs from "node:fs";
    import { dirname, join } from "node:path";
    ${WORKER_OWNER_WATCH_SCRIPT}
    const [role, root, target, source] = process.argv.slice(2);
    process.env.TPS_MAIL_DIR = root;
    const signal = (name) => fs.writeFileSync(join(root, name), "ready");
    ${ownerAwareGateWaitScript()}
    const mail = await import(source);
    signal(role + "-ready");
    wait("go");
    try {
      mail.ackMessageAtPath(target, dirname(dirname(target)));
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
