/**
 * CLI slice-A producer integration checks. The tests exercise real promotion
 * for each delivered CLI producer, including both branch forward forms and
 * MailClient. Health probe rejection is checked against the same policy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

import { promote, sendMessage } from "../src/utils/mail.js";
import { sendSignedMail } from "../src/utils/mail-producer.js";
import { defaultMailSender } from "../src/commands/pulse.js";
import { createTopic, subscribe, publishToTopic, catchUpTopics } from "../src/utils/mail-topics.js";
import { sendOnboardingMail } from "../src/cli/hire.js";
import { runRoster } from "../src/commands/roster.js";
import { sendIntroduction, healthMail } from "../src/commands/bootstrap.js";
import { routeHandlerAction } from "../src/commands/branch.js";
import { MailClient } from "../../agent/src/io/mail.js";

const FLINT = Buffer.alloc(32, 0x11);
const ANVIL = Buffer.alloc(32, 0x22);
const HOST = Buffer.alloc(32, 0x33);
const KERN = Buffer.alloc(32, 0x44);
const SEEDS: Record<string, Buffer> = { flint: FLINT, anvil: ANVIL, host: HOST, kern: KERN };

function pubkeyBase64(seed: Buffer): string {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed))).toString("base64");
}

interface StubFlair {
  url: string;
  stop(): void;
}

/** Stub Flair: /Health, /Agent/<name> (public keys), /Identity/<name>, /OrgEvent/. */
function startStubFlair(seeds: Record<string, Buffer>): StubFlair {
  const pubs: Record<string, string> = {};
  for (const [name, seed] of Object.entries(seeds)) pubs[name] = pubkeyBase64(seed);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/Health") return new Response("ok");
      const agent = url.pathname.match(/^\/Agent\/(.+)$/);
      if (agent) {
        const name = decodeURIComponent(agent[1]!);
        const pk = pubs[name];
        if (!pk) return new Response("not found", { status: 404 });
        return Response.json({ id: name, name, publicKey: pk });
      }
      const ident = url.pathname.match(/^\/Identity\/(.+)$/);
      if (ident) {
        const name = decodeURIComponent(ident[1]!);
        return Response.json({ id: name });
      }
      if (url.pathname === "/OrgEvent/") return new Response("", { status: 204 });
      if (url.pathname === "/Presence") return new Response("", { status: 204 });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("cli#433 slice A: every CLI-internal producer signs its mail", () => {
  let home: string;
  let mailDir: string;
  let keysDir: string;
  let emptyKeys: string;
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tps-producer-sign-"));
    mailDir = join(home, ".tps", "mail");
    keysDir = join(home, "keys");
    emptyKeys = join(home, "no-keys");
    mkdirSync(keysDir, { recursive: true });
    mkdirSync(emptyKeys, { recursive: true });
    for (const [name, seed] of Object.entries(SEEDS)) writeFileSync(join(keysDir, `${name}.key`), seed);

    stub = startStubFlair(SEEDS);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "TPS_AGENT_ID", "TPS_TEST_KEYS_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = home;
    process.env.TPS_MAIL_DIR = mailDir;
    process.env.TPS_AGENT_ID = "anvil";
    process.env.TPS_TEST_KEYS_DIR = keysDir;
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, "kern.key");
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** The single record in <mailDir>/<agent>/new/, promoted through the real enforcer. */
  async function promoteNew(agent: string) {
    const newDir = join(mailDir, agent, "new");
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    return promote(agent, join(newDir, files[0]!));
  }

  test("pulse defaultMailSender signs as the notifying agent", async () => {
    defaultMailSender("kern", "PR #1 is merge-ready", "flint");
    const result = await promoteNew("kern");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.from).toBe("flint");
  });

  test("topic fan-out (publishToTopic) signs as the publisher", async () => {
    createTopic("eng", "engineering");
    subscribe("eng", "kern");
    publishToTopic("eng", "flint", "deploy window open");
    const result = await promoteNew("kern");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.from).toBe("flint");
      expect(result.message.body).toBe("deploy window open");
    }
  });

  test("topic catch-up (catchUpTopics) signs as the original publisher", async () => {
    createTopic("eng2", "engineering");
    publishToTopic("eng2", "flint", "missed while away");
    subscribe("eng2", "kern", true); // subscribe from the beginning → the entry is missed
    const delivered = catchUpTopics("kern");
    expect(delivered).toBeGreaterThanOrEqual(1);
    const result = await promoteNew("kern");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.from).toBe("flint");
  });

  test("hire onboarding signs as the CLI's own identity", async () => {
    sendOnboardingMail("host", "kern", "Kern", "developer", "/ws/kern");
    const result = await promoteNew("kern");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.from).toBe("host");
      expect(result.message.body).toContain("Welcome to the team, Kern!");
    }
  });

  test("roster invite signs as the inviter", async () => {
    const configPath = join(home, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ agents: { list: [] } }, null, 2));
    await runRoster({
      action: "invite",
      agent: "flint",
      message: "Welcome to TPS",
      flairUrl: stub.url,
      keyPath: join(keysDir, "anvil.key"),
      mailDir,
      json: true,
      configPath,
    });
    const result = await promoteNew("flint");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.from).toBe("anvil");
  });

  test("bootstrap introduction signs as the CLI's own identity", async () => {
    sendIntroduction("kern", "Welcome aboard (developer)", "host");
    // deliverToSandbox writes to <branch-office>/<team>/mail/new.
    const newDir = join(home, ".tps", "branch-office", "kern", "mail", "new");
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const result = await promote("kern", join(newDir, files[0]!));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.from).toBe("host");
  });

  test("branch reply signs the handler-generated body as the local agent", async () => {
    const queued: Array<{ to: string; body: string; from: string }> = [];
    const route = routeHandlerAction(
      { type: "reply", body: "pong", to: "kern" },
      { id: "m1", from: "kern", to: "anvil", body: "<signed original>" },
      (to, body, from) => queued.push({ to, body, from }),
    );
    expect(route).toEqual({ kind: "reply", to: "kern" });
    expect(queued).toHaveLength(1);
    sendMessage("kern", queued[0]!.body, queued[0]!.from);
    const result = await promoteNew("kern");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.from).toBe("anvil");
      expect(result.message.body).toBe("pong");
    }
  });

  test("branch forward signs as the forwarding identity and promotes", async () => {
    // Rewritten body → signed.
    const rewritten: Array<{ to: string; body: string; from: string }> = [];
    const r1 = routeHandlerAction(
      { type: "forward", body: "rewritten body", to: "kern" },
      { id: "m2", from: "flint", to: "anvil", body: "<signed original>" },
      (to, body, from) => rewritten.push({ to, body, from }),
    );
    expect(r1).toEqual({ kind: "forward", to: "kern" });
    expect(rewritten).toHaveLength(1);
    sendMessage("kern", rewritten[0]!.body, rewritten[0]!.from);
    const promoted = await promoteNew("kern");
    expect(promoted.ok).toBe(true);

    // Unchanged incoming content is carried as data in a new forwarder-signed envelope.
    const relayed: Array<{ to: string; body: string; from: string }> = [];
    const r2 = routeHandlerAction(
      { type: "forward", body: "<incoming content>", to: "kern" },
      { id: "m3", from: "flint", to: "anvil", body: "<incoming content>" },
      (to, body, from) => relayed.push({ to, body, from }),
    );
    expect(r2).toEqual({ kind: "forward", to: "kern" });
    expect(relayed[0]!.from).toBe("anvil");
    expect(JSON.parse(relayed[0]!.body).body).toBe("<incoming content>");
    sendMessage("kern", relayed[0]!.body, relayed[0]!.from);
    const forwarded = await promoteNew("kern");
    expect(forwarded.ok).toBe(true);
    if (forwarded.ok) expect(forwarded.message.from).toBe("anvil");
  });

  test("MailClient sendMail resolves the Flair-only key and recipient promotes it", async () => {
    delete process.env.TPS_TEST_KEYS_DIR;
    const flairKeys = join(home, ".flair", "keys");
    mkdirSync(flairKeys, { recursive: true });
    writeFileSync(join(flairKeys, "flint.key"), FLINT);
    const client = new MailClient(mailDir, undefined, "flint", { getAgent: async () => null });
    await client.sendMail("kern", "agent runtime mail");
    const outbox = join(mailDir, "flint", "outbox");
    const [file] = readdirSync(outbox).filter((f) => f.endsWith(".json"));
    const record = JSON.parse(readFileSync(join(outbox, file!), "utf8"));
    sendMessage("kern", record.body, record.from);
    const result = await promoteNew("kern");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.body).toBe("agent runtime mail");
  });

  test("bootstrap health fails when the sender key disagrees with Flair", async () => {
    writeFileSync(join(keysDir, "host.key"), Buffer.alloc(32, 0x55));
    expect(await healthMail("kern", "host")).toBe(false);
    const cur = join(home, ".tps", "branch-office", "kern", "mail", "cur");
    expect(existsSync(cur) ? readdirSync(cur).filter((f) => f.endsWith(".json")) : []).toHaveLength(0);
  });

  test("a missing signing key refuses with the named error and writes nothing", async () => {
    process.env.TPS_TEST_KEYS_DIR = emptyKeys;
    let thrown: Error | null = null;
    try {
      sendSignedMail("flint", "kern", "unsigned attempt");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("no Ed25519 private key for agent \"flint\"");

    // The producer side of the branch route reports the refusal and queues nothing.
    const queued: unknown[] = [];
    const route = routeHandlerAction(
      { type: "reply", body: "pong", to: "kern" },
      { id: "m4", from: "kern", to: "anvil", body: "<signed original>" },
      (...args) => queued.push(args),
    );
    expect(route.kind).toBe("refused");
    expect(queued).toHaveLength(0);

    const newDir = join(mailDir, "kern", "new");
    expect(existsSync(newDir) ? readdirSync(newDir).filter((f) => f.endsWith(".json")).length : 0).toBe(0);
  });
});
