/**
 * mail-unresolvable-principal.test.ts — the release-gate drills for cli#383.
 *
 * Every test here runs the REAL path: `promote()`/`checkMessages()` build their
 * Flair client unconditionally, so the drills stand up a stub Flair HTTP server
 * (one that, for the spoke case, holds ONLY the mailbox's own principal) and
 * point FLAIR_URL/FLAIR_KEY_PATH at it.
 *
 * The three drills, all required by the settled design (cli#383, last comment):
 *   (a) a signed hub-agent envelope to a spoke-shaped mailbox lands the new
 *       terminal class `unresolvable-principal`, and the `.reason` sidecar names
 *       BOTH the topology and the non-delivery;
 *   (b) the NO-DOWNGRADE PIN: `unresolvable-principal` alarms IDENTICALLY to
 *       `invalid` in every consumer of the class field — asserted directly
 *       against `RETRYABLE_REJECT_CLASSES` and, behaviourally, on the dlq path;
 *   (c) the boundary is RESOLVABILITY, not forgery amnesty: the SAME forged
 *       envelope lands `invalid` when the named principal is resolvable and
 *       `unresolvable-principal` when it is not.
 *
 * Each drill fails against origin/main: (a) and (b) because the class does not
 * exist there, and (c) because origin/main has no resolvability boundary — it
 * files the absent-principal arm as `invalid`, so the two arms collapse.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sendMessage, checkMessages, getInbox, RETRYABLE_REJECT_CLASSES } from "../src/utils/mail.js";
import type { Envelope } from "@tpsdev-ai/agent";
import { startStubFlair, writeKeyFile, buildSignedEnvelope, type StubFlair } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");

const FLINT_SEED = Buffer.alloc(32, 0x01);
const ANVIL_SEED = Buffer.alloc(32, 0x04);

describe("unresolvable-principal release gate (cli#383)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stubs: StubFlair[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-unresolvable-"));
    keysDir = join(tempRoot, "keys");
    stubs = [];
    // The mailbox's own key file — authenticates the CLI FlairClient's reads.
    writeKeyFile(keysDir, "anvil", ANVIL_SEED);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "TPS_AGENT_ID", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    process.env.TPS_AGENT_ID = "anvil";
    process.env.FLAIR_KEY_PATH = join(keysDir, "anvil.key");
  });

  afterEach(() => {
    for (const s of stubs) s.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  /** Point the always-constructed verify client at a stub holding `seeds`. */
  function useFlair(seeds: Record<string, Buffer>): StubFlair {
    const s = startStubFlair(seeds);
    stubs.push(s);
    process.env.FLAIR_URL = s.url;
    return s;
  }

  function jsonFiles(dir: string): string[] {
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => e.name)
      : [];
  }
  function reasonFor(mailDir: string, agent: string, filename: string): string | null {
    try {
      return readFileSync(join(mailDir, agent, "dlq", `${filename}.reason`), "utf-8");
    } catch {
      return null;
    }
  }

  /** Drive the real CLI in a child process (the dlq consumer path). */
  async function run(args: string[], env: Record<string, string>) {
    const home = env.HOME ?? join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
      cwd: tempRoot,
      env: { ...process.env, HOME: home, TPS_TEST_KEYS_DIR: keysDir, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  }

  // ── (a) hub agent → spoke mailbox: topology class, named, non-delivered ────
  test("(a) a signed envelope from a principal absent from the local Flair lands unresolvable-principal, naming topology and non-delivery", async () => {
    useFlair({ anvil: ANVIL_SEED }); // the spoke holds ONLY itself
    const env = buildSignedEnvelope("flint", "anvil", "hub dispatch over the wire", { flint: FLINT_SEED });
    sendMessage("anvil", JSON.stringify(env), "flint");

    const inbox = getInbox("anvil");
    const [file] = jsonFiles(inbox.fresh);
    expect(file).toBeTruthy();

    const msgs = await checkMessages("anvil");
    expect(msgs.length).toBe(0); // never delivered
    expect(jsonFiles(inbox.cur).length).toBe(0);
    expect(jsonFiles(inbox.dlq).length).toBe(1);

    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "anvil", file!);
    expect(reason).not.toBeNull();
    expect(reason).toContain("class: unresolvable-principal");
    expect(reason).toContain("flint"); // names the specific entry
    expect(reason).toMatch(/local Flair/i); // names the topology
    expect(reason).toMatch(/spoke/i);
    expect(reason).toContain("383"); // the issue
    expect(reason).toMatch(/DEAD-LETTERED, NOT delivered/); // disposition, plainly
  });

  // ── (b) the no-downgrade pin ──────────────────────────────────────────────
  test("(b) no-downgrade pin: unresolvable-principal alarms identically to invalid in every class consumer", async () => {
    // Structural: the ONE behavioural lever is membership in this set, so a
    // direct assertion is the pin. The set is live (not vacuous) — a Flair
    // outage IS retryable.
    expect(RETRYABLE_REJECT_CLASSES.has("unresolvable-principal")).toBe(false);
    expect(RETRYABLE_REJECT_CLASSES.has("invalid")).toBe(false);
    expect(RETRYABLE_REJECT_CLASSES.has("verify-unavailable")).toBe(true);

    useFlair({ anvil: ANVIL_SEED });
    const env = buildSignedEnvelope("flint", "anvil", "hub dispatch", { flint: FLINT_SEED });
    sendMessage("anvil", JSON.stringify(env), "flint");
    const inbox = getInbox("anvil");
    const [file] = jsonFiles(inbox.fresh);

    const first = await checkMessages("anvil");
    expect(first.length).toBe(0);
    expect(jsonFiles(inbox.dlq).length).toBe(1);

    // Behavioural parity with `invalid`: a terminal reject is NOT re-driven on a
    // later check, and is never presented.
    const second = await checkMessages("anvil");
    expect(second.length).toBe(0);
    expect(jsonFiles(inbox.dlq).length).toBe(1); // still one — not re-promoted
    expect(jsonFiles(inbox.cur).length).toBe(0);
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "anvil", file!)).toContain("class: unresolvable-principal");

    // Consumer parity: both classes surface through the SAME rendering path
    // (`mail list` reads the class field), so a future alert wired to `invalid`
    // cannot silently miss the new class. Plant an `invalid` sibling to prove the
    // path is shared rather than special-cased for the new name.
    writeFileSync(
      join(inbox.dlq, "invalid-sibling.json"),
      JSON.stringify({ id: "sibling-invalid", from: "flint", to: "anvil", body: "", timestamp: new Date().toISOString(), read: true }),
      "utf-8",
    );
    writeFileSync(join(inbox.dlq, "invalid-sibling.json.reason"), "class: invalid\nReason: nope\n", "utf-8");

    const listed = await run(["mail", "list", "anvil"], {
      TPS_MAIL_DIR: process.env.TPS_MAIL_DIR!,
      TPS_AGENT_ID: "anvil",
    });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("[dlq: unresolvable-principal]");
    expect(listed.stdout).toContain("[dlq: invalid]");
  });

  // ── (c) boundary is resolvability, not forgery amnesty ────────────────────
  test("(c) the SAME forged envelope lands invalid when the principal is resolvable and unresolvable-principal when it is not", async () => {
    // A genuine signature, then FORGED: corrupt the outer signature. The only
    // thing that differs between the two arms is the local Flair principal set.
    const genuine = buildSignedEnvelope("flint", "anvil", "forged body", { flint: FLINT_SEED });
    const forged: Envelope = { ...genuine, signature: `ed25519:${Buffer.alloc(64, 0).toString("base64")}` };

    // Arm 1 — the named principal IS resolvable → a real signature failure.
    useFlair({ anvil: ANVIL_SEED, flint: FLINT_SEED });
    sendMessage("anvil", JSON.stringify(forged), "flint");
    {
      const inbox = getInbox("anvil");
      const [file] = jsonFiles(inbox.fresh);
      const msgs = await checkMessages("anvil");
      expect(msgs.length).toBe(0);
      const reason = reasonFor(process.env.TPS_MAIL_DIR!, "anvil", file!);
      expect(reason).toContain("class: invalid");
      expect(reason).not.toContain("unresolvable-principal");
      expect(reason).toMatch(/signature/i);
    }

    // Arm 2 — the SAME forged bytes, principal NOT resolvable → topology class.
    useFlair({ anvil: ANVIL_SEED });
    sendMessage("anvil", JSON.stringify(forged), "flint");
    {
      const inbox = getInbox("anvil");
      const [file] = jsonFiles(inbox.fresh);
      const msgs = await checkMessages("anvil");
      expect(msgs.length).toBe(0);
      const reason = reasonFor(process.env.TPS_MAIL_DIR!, "anvil", file!);
      expect(reason).toContain("class: unresolvable-principal");
    }
  });
});
