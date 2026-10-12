import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkMessages, getInbox, listMessages, promote, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal, relayAcceptanceReceiptPath } from "../src/utils/relay.js";
import { runMail } from "../src/commands/mail.js";
import { buildSignedEnvelope, pubkeyFromSeed, writeKeyFile } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const seeds = { remote: Buffer.alloc(32, 0x11), local: Buffer.alloc(32, 0x22) };

describe("relay review regressions", () => {
  let root: string;
  let mail: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-relay-review-"));
    mail = join(root, "mail");
    savedEnv = {};
    for (const key of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) savedEnv[key] = process.env[key];
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = mail;
    process.env.FLAIR_URL = "http://flair.invalid";
    process.env.FLAIR_KEY_PATH = writeKeyFile(join(root, "keys"), "local", seeds.local);
  });

  afterEach(() => {
    mock.restore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function body() {
    return { id: randomUUID(), from: "remote", to: "local", content: "relay payload", timestamp: "2000-01-01T00:00:00.000Z" };
  }

  function traceSync(denied?: string, once = false) {
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const paths = new Map<number, string>();
    const synced: string[] = [];
    let refused = false;
    spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (String(path) === denied && !(once && refused)) {
        refused = true;
        throw Object.assign(new Error("traverse-only ancestor"), { code: "EACCES" });
      }
      const fd = open(path, flags, mode);
      paths.set(fd, String(path));
      return fd;
    });
    spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      synced.push(paths.get(fd)!);
      return sync(fd);
    });
    return synced;
  }

  test("relay publication and reuse sync their changed parents", () => {
    const inbox = getInbox("local");
    const accepted = join(mail, ".relay-accepted", "by-branch", "remote");
    fs.mkdirSync(accepted, { recursive: true });
    const synced = traceSync(root);
    const message = body();
    expect(deliverRelayedToLocal("remote", message)).toBe(true);
    expect(deliverRelayedToLocal("remote", message)).toBe(false);
    const [file] = fs.readdirSync(inbox.fresh);
    expect(JSON.parse(fs.readFileSync(join(inbox.fresh, file!), "utf8")).body).toBe(message.content);
    const directories = synced.filter((path) => !path.endsWith(".json") && !path.endsWith(message.id) && !path.endsWith(".tmp"));
    for (const path of [inbox.tmp, inbox.fresh, join(accepted, new Date().toISOString().slice(0, 10))]) expect(directories).toContain(path);
  });

  test("relay publication syncs parents of newly created directories", () => {
    const synced = traceSync(dirname(root));
    const message = body();
    expect(deliverRelayedToLocal("remote", message)).toBe(true);
    const inbox = getInbox("local");
    const acceptedRoot = join(mail, ".relay-accepted");
    const directories = synced.filter((path) => !path.endsWith(".json") && !path.endsWith(message.id) && !path.endsWith(".tmp"));
    for (const path of [root, mail, inbox.root, inbox.tmp, inbox.fresh, join(acceptedRoot, "by-branch", "remote", new Date().toISOString().slice(0, 10))]) expect(directories).toContain(path);
  });

  test("a retry syncs directory entries left pending by a creation sync failure", () => {
    getInbox("local");
    const acceptedRoot = join(mail, ".relay-accepted");
    const synced = traceSync(acceptedRoot, true);
    const message = body();
    expect(() => deliverRelayedToLocal("remote", message)).toThrow("relay acceptance receipt write failed; retry delivery");
    synced.length = 0;
    expect(deliverRelayedToLocal("remote", message)).toBe(true);
    expect(synced).toContain(acceptedRoot);
    expect(synced).toContain(mail);
    expect(JSON.parse(fs.readFileSync(relayAcceptanceReceiptPath("remote", message.id), "utf8"))).toEqual({
      from: message.from,
      to: message.to,
      timestamp: message.timestamp,
      bodySha256: createHash("sha256").update(message.content, "utf8").digest("hex"),
      bodyLength: Buffer.byteLength(message.content, "utf8"),
    });
  });

  for (const dir of ["new", "cur", "dlq"] as const) {
    test(`a truncated ${dir} record is preserved and reported; a marked delivery with no usable receipt is refused`, () => {
      const inbox = getInbox("local");
      const message = body();
      const corrupt = join(inbox.root, dir, "truncated.json");
      const raw = `{"relayDelivery":{"branchId":"remote","id":"${message.id}"},`;
      fs.writeFileSync(corrupt, raw);
      const accepted = join(mail, ".relay-accepted", "by-branch", "remote");
      fs.mkdirSync(accepted, { recursive: true });
      fs.mkdirSync(join(accepted, new Date().toISOString().slice(0, 10)), { recursive: true });
      fs.writeFileSync(relayAcceptanceReceiptPath("remote", message.id), "");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      expect(() => deliverRelayedToLocal("remote", message)).toThrow(`relayed delivery conflict for branch remote message ${message.id}`);
      const quarantine = join(inbox.root, "quarantine");
      const files = fs.readdirSync(quarantine).filter((file) => file.endsWith(".json"));
      expect(files).toHaveLength(1);
      const path = join(quarantine, files[0]!);
      expect(fs.readFileSync(path, "utf8")).toBe(raw);
      expect(fs.readFileSync(`${path}.reason`, "utf8")).toContain(corrupt);
      expect(errors.mock.calls.flat().join("\n")).toContain(corrupt);
      expect(fs.readdirSync(join(inbox.root, dir))).not.toContain("truncated.json");
      fs.rmSync(relayAcceptanceReceiptPath("remote", message.id));
      expect(deliverRelayedToLocal("remote", message)).toBe(true);
      const records = fs.readdirSync(inbox.fresh).filter((file) => file.endsWith(".json"));
      expect(records).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(join(inbox.fresh, records[0]!), "utf8")).body).toBe(message.content);
    });
  }

  test("a record read failure refuses relay acceptance and preserves the record", () => {
    const inbox = getInbox("local");
    const source = join(inbox.fresh, "unreadable.json");
    const raw = "{truncated";
    fs.writeFileSync(source, raw);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const read = fs.readFileSync;
    const fault = spyOn(fs, "readFileSync").mockImplementation((path, options) => {
      if (String(path) === source) throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return read(path, options as BufferEncoding);
    });
    const message = body();
    try { expect(() => deliverRelayedToLocal("remote", message)).toThrow(`relayed record read failed: ${source}`); }
    finally { fault.mockRestore(); }
    expect(fs.readFileSync(source, "utf8")).toBe(raw);
    expect(errors.mock.calls.flat().join("\n")).toContain(source);
    const records = fs.readdirSync(inbox.fresh).filter((file) => file !== "unreadable.json" && file.endsWith(".json"));
    expect(records).toHaveLength(0);
    expect(fs.existsSync(relayAcceptanceReceiptPath("remote", message.id))).toBe(false);
  });

  test("mail list and CLI list use receipt time with a timestamp fallback", async () => {
    const inbox = getInbox("local");
    for (const [dir, id, timestamp, receivedAt] of [
      ["new", "newest", "2000-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z"],
      ["cur", "middle", "malformed", "2026-01-03T00:00:00.000Z"],
      ["dlq", "oldest", "2099-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      ["new", "fallback", "2026-01-02T00:00:00.000Z", undefined],
    ] as const) {
      fs.writeFileSync(join(inbox.root, dir, `${id}.json`), JSON.stringify({ id, from: "remote", to: "local", body: "", read: false, timestamp, receivedAt }));
    }
    const ids = ["newest", "middle", "fallback", "oldest"];
    expect((await listMessages("local")).map((record) => record.id)).toEqual(ids);
    const output = spyOn(console, "log").mockImplementation(() => {});
    await runMail({ action: "list", agent: "local", json: true });
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).map((record: { id: string }) => record.id)).toEqual(ids);
  });

  test("mail check orders promoted and recovered relay records by receipt time", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const id = new URL(String(input)).pathname.match(/^\/Agent\/(.+)$/)?.[1];
      const seed = id && seeds[id as keyof typeof seeds];
      return seed ? Response.json({ id, name: id, publicKey: pubkeyFromSeed(seed).toString("base64") }) : new Response("not found", { status: 404 });
    });
    const first = buildSignedEnvelope("remote", "local", "first", seeds);
    await Bun.sleep(2);
    const second = buildSignedEnvelope("remote", "local", "second", seeds);
    const records = [first, second].map((env) => sendMessage("local", JSON.stringify(env), "remote", { branchId: "remote", id: randomUUID() }, env.timestamp));
    for (const [index, record] of records.entries()) {
      const persisted = JSON.parse(fs.readFileSync(record.filePath, "utf8"));
      persisted.receivedAt = index === 0 ? "2099-01-02T00:00:00.000Z" : "2099-01-01T00:00:00.000Z";
      fs.writeFileSync(record.filePath, JSON.stringify(persisted));
    }
    expect((await promote("local", records[0]!.filePath)).ok).toBe(true);
    const inbox = getInbox("local");
    const [cur] = fs.readdirSync(inbox.cur).filter((file) => file.endsWith(".json"));
    const curPath = join(inbox.cur, cur!);
    const recovered = JSON.parse(fs.readFileSync(curPath, "utf8"));
    recovered.read = false;
    delete recovered.checkedOutAt;
    delete recovered.checkedOutBy;
    fs.writeFileSync(curPath, JSON.stringify(recovered));
    expect((await checkMessages("local")).map((record) => record.envelopeId)).toEqual([first.messageId, second.messageId]);
  });
});
