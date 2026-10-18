/**
 * tps agent — Agent lifecycle and TPS runtime management.
 *
 * Subcommands:
 *   create   Provision a new agent: generate keys, register in Flair, write config
 *   run      Single-shot: process one message and exit
 *   start    Long-running daemon: poll mail, process, respond
 *   health   Print "healthy" / "unhealthy"
 *   list     Show registered agents in Flair
 *   status   Show status of a running agent (PID, last activity, Flair memory count)
 */

import { AgentRuntime, loadAgentConfig } from "@tpsdev-ai/agent";
import { agentWorkspace } from "../utils/agent-workspace.js";
import yaml from "js-yaml";
import { generateKeyPair, saveKeyPair, loadKeyPair, verify } from "../utils/identity.js";
import { createFlairClient, FlairAgentKeyRegisterError, FlairRequestError, isEncryptedPrivateKeyPem, loadFlairSigningKey } from "../utils/flair-client.js";
import { applyRole, loadPlugins } from "../plugins/index.js";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { accessSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { sign as cryptoSign } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve as resolvePathMod } from "node:path";
import {
  runCommandUnderNono,
  isNonoStrict,
  isInteractiveTty,
  isSupervised,
  agentLaunchOptions,
  runtimeNonoOptions,
  runtimeNonoProfile,
  sandboxProfileGrantRefusal,
  REFUSAL_EXIT_CODE,
  SUPERVISED_REFUSAL_EXIT_CODE,
  canonicalPath,
} from "../utils/nono.js";
import { launchAttested, resolveNonoBinary } from "../utils/launch-attestation.js";
import { requireLocalAgentId } from "../utils/local-agent.js";

export interface AgentArgs {
  action: "run" | "start" | "health" | "create" | "list" | "status" | "decommission" | "commit" | "isolate" | "logs" | "healthcheck";
  config?: string;
  message?: string;
  /** For create/list/status */
  displayName?: string;
  soulFile?: string;
  noSeed?: boolean;
  starterMemories?: Array<{ content: string; tags?: string[]; durability?: string }>;
  id?: string;
  name?: string;
  model?: string;
  flairUrl?: string;
  json?: boolean;
  verbose?: boolean;
  force?: boolean;
  port?: number;
  repo?: string;
  branchName?: string;
  commitMessage?: string;
  authorName?: string;
  authorEmail?: string;
  paths?: string[];
  push?: boolean;
  prTitle?: string;
  sandbox?: boolean;
  /** Internal: set by re-exec under nono, skips re-wrapping */
  sandboxed?: boolean;
  /** The launch unit asserted --sandbox-required; carry it into the re-exec. */
  sandboxRequired?: boolean;
  /**
   * The selected agent runtime (`--runtime claude-code|codex|gemini`). Carried
   * into the attested re-exec so the sandboxed child runs the runtime runner
   * (cli#363 slice B); undefined for the default AgentRuntime path.
   */
  runtime?: string;
  lines?: number;
  follow?: boolean;
  ackScopeExpansion?: boolean;
  scopeWarnThreshold?: number;
}

interface AgentHealthcheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

function healthcheckHomeDir(): string {
  return process.env.TPS_HOME ?? homedir();
}

function agentHomeDir(): string {
  return process.env.TPS_HOME ?? homedir();
}

function archivePath(path: string, timestamp: string): string {
  return `${path}.archived-${timestamp}`;
}

function archiveIfExists(path: string, timestamp: string): string | null {
  if (!existsSync(path)) return null;
  const archived = archivePath(path, timestamp);
  renameSync(path, archived);
  return archived;
}

async function confirmDecommission(agentId: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Refusing to prompt without a TTY. Re-run with --force to skip confirmation.");
    process.exit(1);
  }

  const rl = createPromptInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Decommission agent '${agentId}'? This archives local state and marks the Flair agent decommissioned. Type '${agentId}' to continue: `,
    );
    if (answer.trim() !== agentId) {
      console.error("Decommission cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function normalizeLogLineCount(lines?: number): number {
  if (lines === undefined) return 50;
  if (!Number.isInteger(lines) || lines <= 0) {
    console.error(`--lines must be a positive integer. Got: ${lines}`);
    process.exit(1);
  }
  return lines;
}

function tailLines(content: string, count: number): string[] {
  if (!content) return [];
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  return lines.slice(-count);
}

async function streamLogUpdates(logPath: string, offset: number): Promise<never> {
  let position = offset;
  let reading = false;
  let pending = false;

  const readFromPosition = (): void => {
    if (reading) {
      pending = true;
      return;
    }

    const size = statSync(logPath).size;
    if (size < position) {
      position = 0;
    }
    if (size === position) return;

    reading = true;
    const stream = createReadStream(logPath, {
      encoding: "utf-8",
      start: position,
      end: size - 1,
    });

    stream.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    stream.on("end", () => {
      position = size;
      reading = false;
      if (pending) {
        pending = false;
        readFromPosition();
      }
    });

    stream.on("error", () => {
      reading = false;
    });
  };

  await new Promise<never>(() => {
    const watcher = watch(logPath, { persistent: true }, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        readFromPosition();
      }
    });

    const handleSigint = (): void => {
      watcher.close();
      process.removeListener("SIGINT", handleSigint);
      process.stdout.write("\n");
      process.exit(0);
    };

    process.on("SIGINT", handleSigint);
  });

  process.exit(0);
}

async function logAgentRuntime(args: AgentArgs): Promise<void> {
  const agentId = args.id;
  if (!agentId) {
    console.error("Usage: tps agent logs --id <agent-id> [--lines <N>] [--follow|-f]");
    process.exit(1);
  }

  const lineCount = normalizeLogLineCount(args.lines);
  const logPath = join(healthcheckHomeDir(), ".tps", "agents", agentId, "session.log");
  if (!existsSync(logPath)) {
    console.error(`No log file found for ${agentId}`);
    process.exit(1);
  }

  const content = readFileSync(logPath, "utf-8");
  const lines = tailLines(content, lineCount);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }

  if (args.follow) {
    await streamLogUpdates(logPath, statSync(logPath).size);
  }
}
// ─── create ──────────────────────────────────────────────────────────────────

async function loadSoulFile(filePath: string): Promise<Record<string, string>> {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(filePath, "utf8");
  // Support simple KEY: value YAML or JSON
  if (filePath.endsWith(".json")) return JSON.parse(raw);
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

/** Flair stores base64url (`flair agent add`) and accepts hex or base64/base64url; only a 32-byte decode is a key. */
function storedKeyAsHex(stored: string): string | null {
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(stored)) bytes = Buffer.from(stored, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(stored)) bytes = Buffer.from(stored, "base64");
  else return null;
  return bytes.length === 32 ? bytes.toString("hex") : null;
}

/** Whether an Agent row was confirmed to exist when the registration is refused. */
type RowState = "exists" | "absent" | "unknown";

/**
 * cli#512 — when Flair is reachable, `create` exits non-zero here unless the
 * stored key reads back equal to the generated key.
 *
 * cli#593 — `rowState` is three-valued. A failed read-back leaves the row's
 * existence unknown, and the remedy then names both branches rather than the
 * no-row one.
 */
function refuseRegistration(
  id: string,
  flairUrl: string,
  identityDir: string,
  detail: string,
  writeError: string | null,
  rowState: RowState,
): never {
  const cause = writeError ? `${detail}; the registration write failed: ${writeError}` : detail;
  console.error(`❌ Agent '${id}' is not registered in Flair at ${flairUrl} — ${cause}.`);
  console.error(
    `   Flair drops publicKey on Agent PUT/PATCH; the operation that stores a key on an existing pending row is POST /AgentKeyRegister (flair#2266).`,
  );
  const copy = `copy ${join(identityDir, `${id}.key`)} and ${join(identityDir, `${id}.pub`)} into the Flair host's keys dir, run \`flair agent add ${id} --keys-dir <dir>\` there, then re-run \`tps agent create\``;
  if (rowState === "exists") {
    console.error(
      `   Until then: run \`flair agent remove ${id}\` on the Flair host, then ${copy}.`,
    );
    console.error(
      `   ⚠️  \`flair agent remove\` tries to delete the agent's Agent, Memory and Soul rows and its key files in the keys dir (unless --keep-keys); it can stop on a failure.`,
    );
  } else if (rowState === "unknown") {
    console.error(
      `   Until then: if \`flair agent show ${id}\` finds the agent, it already exists: run \`flair agent remove ${id}\` on the Flair host first (this tries to delete that agent's Memory and Soul rows and can stop on a failure), then ${copy}.`,
    );
    console.error(`   Otherwise: ${copy}.`);
  } else {
    console.error(`   Until then: ${copy}.`);
  }
  process.exit(1);
}

/**
 * cli#607 — a probe signed with the private key does not verify under the
 * public key file (or the key cannot make an Ed25519 signature at all), so the
 * file is not the private key's public half. Registering it would register a
 * key this identity's signatures never verify against, so refuse before
 * reaching Flair.
 */
function refuseKeyPairMismatch(id: string, identityDir: string, keyPath: string, pubPath: string): never {
  console.error(`❌ Agent '${id}' has no consistent key pair at ${identityDir} — the private key in ${keyPath} does not derive the public key in ${pubPath}.`);
  console.error(`   Remedy: move ${keyPath} and ${pubPath} aside, then re-run \`tps agent create --id ${id}\` to generate a matched pair.`);
  process.exit(1);
}

/**
 * cli#607 — the Flair client could not load the private key file. The client
 * loads an unencrypted PEM private key, a raw 32-byte Ed25519 seed or base64
 * PKCS8 DER, and passes no passphrase, so an encrypted PEM key is named as
 * such. Neither branch prints the key's bytes; only the branch for any other
 * unusable key names the file's length.
 */
function refuseUnusablePrivateKey(id: string, keyPath: string, pubPath: string, keyBytes: Uint8Array): never {
  const encrypted = isEncryptedPrivateKeyPem(Buffer.from(keyBytes).toString("utf-8"));
  const formats = "an unencrypted PEM private key, a raw 32-byte Ed25519 seed or base64 PKCS8 DER";
  const state = encrypted
    ? `the file is an encrypted PEM private key, and encrypted keys are not supported: the Flair client loads keys without a passphrase`
    : `the file holds ${keyBytes.length} bytes and could not be loaded as ${formats}, the formats the Flair client signs with`;
  console.error(`❌ Agent '${id}' has no usable private key at ${keyPath} — ${state}.`);
  console.error(
    `   Remedy: if this agent's identity must be kept, write its key to ${keyPath} unencrypted, as ${formats}; otherwise move ${keyPath} and ${pubPath} aside, then re-run \`tps agent create --id ${id}\` to generate a matched pair.`,
  );
  process.exit(1);
}

/**
 * Whether a directory entry exists at `path`, without following a final
 * symlink: a dangling symlink is an entry (existsSync reports it absent). Only
 * ENOENT and ENOTDIR read as absent; any other lstat error reads as present, so
 * a path that cannot be checked is never written over.
 */
function identityEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * cli#607 — some of this agent's identity paths hold an entry (a file or a
 * symlink, dangling or not), but `.key` and `.pub` do not both exist.
 * Generating a pair here would write over those entries, or through a symlink,
 * so refuse before writing anything.
 */
function refusePartialIdentity(id: string, identityDir: string, present: string[], keyPath: string, pubPath: string): never {
  const missing = [keyPath, pubPath].filter((path) => !existsSync(path));
  const gaps = missing.map((path) => {
    try {
      return lstatSync(path).isSymbolicLink() ? `${path} is a symlink to a missing target` : `${path} cannot be read`;
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? `${path} is missing` : `${path} cannot be checked (${String(code)})`;
    }
  });
  console.error(
    `❌ Agent '${id}' has a partial identity at ${identityDir} — found ${present.join(", ")}, but ${gaps.join(" and ")}; create does not generate a new pair over existing identity entries.`,
  );
  console.error(
    `   Remedy: restore ${missing.join(" and ")} (for a dangling symlink, its target), then re-run \`tps agent create --id ${id}\`; or, to replace this identity, move ${join(identityDir, `${id}.*`)} aside and re-run it to generate a matched pair.`,
  );
  process.exit(1);
}

/**
 * cli#607 — the identity files exist but cannot be loaded: a file `loadKeyPair`
 * reads (`.key`, `.pub`, `.meta.json`, `.seed`, `.x25519.pub`) cannot be read,
 * or the optional `.meta.json` is not JSON. The refusal names the unreadable
 * file and its fs error code, or the invalid `.meta.json`; it never prints an
 * error message or file contents.
 */
function refuseUnloadableIdentity(id: string, identityDir: string, err: unknown): never {
  const metaPath = join(identityDir, `${id}.meta.json`);
  const fsError = err as { code?: unknown; path?: unknown } | null;
  let state: string;
  let repair: string;
  if (fsError && typeof fsError.code === "string" && typeof fsError.path === "string") {
    state = `${fsError.path} cannot be read (${fsError.code})`;
    repair = "make that file readable by the user running tps";
  } else if (err instanceof SyntaxError) {
    state = `${metaPath} is not valid JSON`;
    repair = `repair ${metaPath} or move it aside (create reads it only when present)`;
  } else {
    state = "loading the identity files failed";
    repair = `check the files in ${identityDir}`;
  }
  console.error(`❌ Agent '${id}' cannot load its identity at ${identityDir} — ${state}.`);
  console.error(
    `   Remedy: ${repair}, then re-run \`tps agent create --id ${id}\`; or, to replace this identity, move ${join(identityDir, `${id}.*`)} aside and re-run it to generate a matched pair.`,
  );
  process.exit(1);
}

/**
 * cli#512 — the first Flair release that serves POST /AgentKeyRegister, the
 * operation `create` uses to store a locally generated key on a `pending` row.
 */
const MIN_FLAIR_VERSION_FOR_KEY_REGISTER = "0.62.0";

/** Flair's stored `publicKey` value for an Agent row seeded but not yet registered (flair#2266). */
const PENDING_PUBLIC_KEY = "pending";

/** `refusal` is null when the body is unreadable or names no recognized refusal. */
function refuseKeyRegistration(id: string, flairUrl: string, status: number, refusal: string | null): never {
  if (refusal === null && (status === 404 || status === 405)) {
    console.error(
      `❌ Agent '${id}' — this attempt to register a key in Flair at ${flairUrl} was not confirmed: POST /AgentKeyRegister answered ${status} with no refusal this client recognizes, so whether a key was stored is unknown; this Flair may not serve the route.`,
    );
    console.error(
      `   Remedy: if this Flair predates the route, upgrade it to ${MIN_FLAIR_VERSION_FOR_KEY_REGISTER} or newer, then re-run \`tps agent create --id ${id}\`.`,
    );
    process.exit(1);
  }
  const remedies: Record<string, string> = {
    "authentication required": "the admin credential is empty or invalid; set FLAIR_ADMIN_AUTH to this Flair's admin credential",
    forbidden: "the credential is not this Flair's admin; set FLAIR_ADMIN_AUTH to its admin credential",
    registration_request_invalid: "the agent id or public key was refused as malformed",
    agent_not_found: `no Agent row exists for '${id}'; create the agent's row on this Flair instance, then re-run \`tps agent create --id ${id}\``,
    agent_not_local: `'${id}' did not originate on this instance; register its key on the agent's home instance`,
    agent_inactive: `'${id}' is deactivated; reactivate it before registering a key`,
    agent_key_not_pending: `the stored key for '${id}' is not 'pending', so this operation does not apply; replacing a key is the key-rotation path, not create`,
    registration_conflict: "another write to this agent is in progress or already committed; re-run `tps agent create`",
  };
  if (refusal === null) {
    console.error(`❌ Agent '${id}' — this attempt to register a key in Flair at ${flairUrl} was not confirmed: POST /AgentKeyRegister answered HTTP ${status} with no refusal this client recognizes; whether a key was stored is unknown.`);
    console.error("   Remedy: check that Flair serves this route and its version.");
    process.exit(1);
  }
  const remedy = remedies[refusal] ?? "the endpoint refused the registration; re-run `tps agent create`";
  console.error(`❌ Agent '${id}' — this attempt to register a key in Flair at ${flairUrl} was not confirmed: POST /AgentKeyRegister refused the registration (${refusal}) with HTTP ${status}.`);
  console.error(`   Remedy: ${remedy}.`);
  process.exit(1);
}

/**
 * cli#512 — a read-back after POST /AgentKeyRegister did not confirm the key.
 * `cause` is the client's own bounded account of the POST request; a refusal name is
 * never invented. `observed` is the read-back result or failure.
 */
function refuseKeyRegistrationUnconfirmed(id: string, flairUrl: string, cause: string, observed: string): never {
  console.error(`❌ Agent '${id}' — this attempt to register a key in Flair at ${flairUrl} was not confirmed: ${cause}.`);
  console.error(`   The read-back after the POST ${observed}.`);
  console.error(
    `   Remedy: re-run \`tps agent create --id ${id}\`; it retries registration if the row is still pending and checks the stored key.`,
  );
  process.exit(1);
}

async function createAgent(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent create --id <agent-id> [--name <display-name>] [--model <provider/model>]");
    process.exit(1);
  }

  const name = args.name ?? id;
  const model = args.model ?? "anthropic/claude-sonnet-4-6";
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const identityDir = join(homedir(), ".tps", "identity");
  const keyPrefix = id;

  mkdirSync(identityDir, { recursive: true });

  // 1. Generate Ed25519 keys
  const keyPath = join(identityDir, `${keyPrefix}.key`);
  const pubPath = join(identityDir, `${keyPrefix}.pub`);

  if (existsSync(keyPath) && existsSync(pubPath)) {
    console.log(`  Keys already exist at ${keyPath}`);
  } else {
    // cli#607 — every path saveKeyPair writes: if any holds an entry (a dangling
    // symlink included), the identity is partial, and generating would write over
    // it or through it.
    const present = [".seed", ".key", ".pub", ".x25519.key", ".x25519.pub", ".meta.json"]
      .map((suffix) => join(identityDir, `${keyPrefix}${suffix}`))
      .filter((path) => identityEntryExists(path));
    if (present.length > 0) {
      refusePartialIdentity(id, identityDir, present, keyPath, pubPath);
    }
    console.log(`  Generating Ed25519 keys for ${id}...`);
    saveKeyPair(generateKeyPair(), identityDir, keyPrefix);
    console.log(`  Keys saved to ${identityDir}/`);
  }

  // cli#607 — the identity IS the private key: before registering, sign a probe
  // with it and require the `.pub` on disk to verify that signature. cli#512
  // registered the stored `.pub` bytes verbatim, so a `.pub` that is not the
  // private key's public half could still be reported "registered" when Flair
  // already held that `.pub`. An identity file loadKeyPair reads but cannot
  // load is refused by name. The probe loads the key exactly as the Flair
  // client below signs with it, so every format the client accepts is probed,
  // and a readable key file the client cannot load is refused as unusable.
  let kp: ReturnType<typeof loadKeyPair>;
  try {
    kp = loadKeyPair(identityDir, keyPrefix);
  } catch (e) {
    refuseUnloadableIdentity(id, identityDir, e);
  }
  const probe = Buffer.from(`tps-agent-create:${id}`);
  let signingKey: ReturnType<typeof loadFlairSigningKey>;
  try {
    signingKey = loadFlairSigningKey(keyPath, id);
  } catch {
    refuseUnusablePrivateKey(id, keyPath, pubPath, kp.signing.privateKey);
  }
  let probeSignature: Uint8Array | null;
  try {
    probeSignature = cryptoSign(null, probe, signingKey);
  } catch {
    // A loadable key that cannot make an Ed25519 signature is not this `.pub`'s pair.
    probeSignature = null;
  }
  if (probeSignature === null || !verify(probe, probeSignature, kp.signing.publicKey)) {
    refuseKeyPairMismatch(id, identityDir, keyPath, pubPath);
  }
  const pubKeyHex = Buffer.from(kp.signing.publicKey).toString("hex");

  // 2. Register in Flair, then verify the key actually landed.
  //
  // cli#512: the Flair registration line is printed only when Flair reads the
  // key back equal to the key just generated. Current Flair drops `publicKey` on
  // Agent PUT and PATCH, so neither can store it; a `pending` row is completed
  // through POST /AgentKeyRegister.
  const flair = createFlairClient(id, flairUrl, keyPath);
  const online = await flair.ping();

  if (!online) {
    console.warn(`  ⚠️  Flair not reachable at ${flairUrl} — skipping registration.`);
    console.warn(`  Run setup-harper.sh and retry: tps agent create --id ${id}`);
  } else {
    let writeError: string | null = null;
    let successLine: string | null = null;
    try {
      const existing = await flair.getAgent(id);
      if (existing) {
        if (storedKeyAsHex(existing.publicKey ?? "") !== pubKeyHex) {
          await flair.updateAgent(id, { publicKey: pubKeyHex });
        }
        successLine = `  Agent '${id}' already registered in Flair.`;
      } else if (!args.noSeed) {
        // Seed agent with soul + starter memories
        const soulTemplate = args.soulFile
          ? await loadSoulFile(args.soulFile)
          : undefined;
        const starterMemories = args.starterMemories;
        try {
          const seeded = await flair.seedAgent({
            agentId: id,
            displayName: name,
            role: "agent",
            soulTemplate,
            starterMemories,
          });
          // cli#512: the seed creates a `pending` row if absent; an existing
          // row stays unchanged. The read below determines the stored key.
          successLine = `  Agent seeded: ${seeded.soulEntries.length} soul entries, ${seeded.memories.length} memories.`;
        } catch (seedErr) {
          // AgentSeed requires admin auth — fall back to direct registration
          writeError = `seed failed: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`;
          await flair.registerAgent(name, pubKeyHex);
          successLine = `  Agent '${id}' registered in Flair (no seed — not admin).`;
        }
      } else {
        // --no-seed: just register
        await flair.registerAgent(name, pubKeyHex);
        successLine = `  Agent '${id}' registered in Flair (seeding skipped).`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeError = writeError ? `${writeError}; ${msg}` : msg;
    }

    let registrationPostCause: string | null = null;
    let stored: { found: boolean; publicKey: string | null };
    try {
      stored = await flair.readStoredPublicKey(id);
    } catch (e) {
      // The read failed with a non-404 error: whether a row exists is unknown, so
      // the remedy must name the remove branch as well as the add branch (cli#593).
      refuseRegistration(id, flairUrl, identityDir, `the read-back failed (${e instanceof Error ? e.message : String(e)})`, writeError, "unknown");
    }
    if (stored.found && stored.publicKey === PENDING_PUBLIC_KEY) {
      // cli#512 — register the `pending` row's key, then read it back after
      // success, a transport failure, a success body that is not JSON, or
      // `registration_unavailable`. Definitive refusals exit before that read.
      const publicKeyB64url = Buffer.from(kp.signing.publicKey).toString("base64url");
      let unconfirmed: string | null = null;
      try {
        await flair.registerAgentKey(id, publicKeyB64url);
      } catch (e) {
        if (e instanceof FlairAgentKeyRegisterError) {
          // Flair returns `registration_unavailable` both before committing
          // (nothing changed) and after committing when its own read-back
          // fails, so whether the key is stored is unknown here: the read-back
          // below decides, never as a refusal and never as unregistered.
          if (e.refusal === "registration_unavailable") {
            unconfirmed = "POST /AgentKeyRegister answered registration_unavailable, which Flair returns both before committing (nothing changed) and after committing when its own read-back fails";
          } else {
            refuseKeyRegistration(id, flairUrl, e.status, e.refusal);
          }
        } else if (e instanceof FlairRequestError && e.status !== 0) {
          unconfirmed = `the registration response carried status ${e.status} but no readable JSON body — a response-parsing failure (${e.message})`;
        } else {
          unconfirmed = `the registration request received no response — a transport failure (${e instanceof Error ? e.message : String(e)})`;
        }
      }
      // Read after success or an ambiguous outcome; definitive refusals exited above.
      try {
        stored = await flair.readStoredPublicKey(id);
      } catch (e) {
        refuseKeyRegistrationUnconfirmed(
          id,
          flairUrl,
          unconfirmed ?? "POST /AgentKeyRegister succeeded",
          `failed (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      registrationPostCause = unconfirmed ?? "POST /AgentKeyRegister succeeded";
      if (!(stored.found && storedKeyAsHex(stored.publicKey ?? "") === pubKeyHex)) {
        const observed = !stored.found
          ? "found no Agent row"
          : stored.publicKey === null
            ? "found no stored public key"
            : `found the stored public key '${stored.publicKey}', not the generated key`;
        refuseKeyRegistrationUnconfirmed(id, flairUrl, registrationPostCause, observed);
      }
    }
    if (!stored.found) {
      refuseRegistration(id, flairUrl, identityDir, "no Agent row exists", writeError, "absent");
    } else if (stored.publicKey === null || storedKeyAsHex(stored.publicKey) !== pubKeyHex) {
      const found =
        stored.publicKey === null ? "the row has no public key" : `the stored public key is '${stored.publicKey}'`;
      refuseRegistration(id, flairUrl, identityDir, `${found}, not the generated key`, writeError, "exists");
    }
    // cli#607 — the read-back runs over the operator credential and only shows the
    // bytes Flair stored. Send one request signed with this identity's private key:
    // only its acceptance shows Flair authenticates this agent by this key. A
    // refused signed request, or a response that does not carry the registered
    // key, refuses.
    let confirmed: { publicKey?: string } | undefined;
    try {
      confirmed = await flair.request<{ publicKey?: string }>("GET", `/Agent/${encodeURIComponent(id)}`);
    } catch (e) {
      if (registrationPostCause !== null) {
        refuseKeyRegistrationUnconfirmed(id, flairUrl, registrationPostCause, `failed on the signed request (${e instanceof Error ? e.message : String(e)})`);
      }
      refuseRegistration(id, flairUrl, identityDir, `a request signed with the private key was refused (${e instanceof Error ? e.message : String(e)})`, writeError, "exists");
    }
    if (storedKeyAsHex(confirmed?.publicKey ?? "") !== pubKeyHex) {
      if (registrationPostCause !== null) {
        refuseKeyRegistrationUnconfirmed(id, flairUrl, registrationPostCause, "did not confirm the registered key on the signed request");
      }
      refuseRegistration(id, flairUrl, identityDir, "the signed request was accepted but its response did not confirm the registered key", writeError, "exists");
    }
    console.log(successLine ?? `  Agent '${id}' registered in Flair.`);
  }

  // 3. Write agent config
  const agentsDir = join(homedir(), ".tps", "agents", id);
  mkdirSync(agentsDir, { recursive: true });

  const configPath = join(agentsDir, "agent.yaml");
  const mailDir = join(homedir(), ".tps", "mail");
  const memoryPath = join(agentsDir, "memory.jsonl");
  const workspace = join(homedir(), "ops");

  const [provider, ...modelParts] = model.split("/");
  const modelName = modelParts.join("/");

  const config = `# TPS Agent config for ${id}
agentId: ${id}
name: ${name}
workspace: ${workspace}
mailDir: ${mailDir}
memoryPath: ${memoryPath}
contextWindowTokens: 200000

llm:
  provider: ${provider || "anthropic"}
  model: ${modelName || model}
  # API key is loaded from environment — never store in config
  # For sandbox: point to LLM proxy at localhost
  # baseUrl: http://localhost:6459

tools:
  - read
  - write
  - edit
  - exec
  - mail
`;

  writeFileSync(configPath, config, "utf-8");
  console.log(`  Config written to ${configPath}`);

  console.log(`\n✅ Agent '${id}' is ready.`);
  console.log(`   Run:  tps agent start --id ${id}`);
  console.log(`   Or:   tps agent run --id ${id} --message "hello"`);
}

// ─── list ─────────────────────────────────────────────────────────────────────

async function listAgents(args: AgentArgs): Promise<void> {
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  // List local agent configs
  const agentsDir = join(homedir(), ".tps", "agents");

  if (!existsSync(agentsDir)) {
    console.log("No agents provisioned yet. Run: tps agent create --id <agent-id>");
    return;
  }

  const ids = readdirSync(agentsDir);
  if (ids.length === 0) {
    console.log("No agents found.");
    return;
  }

  const results: Array<{ id: string; name: string; flair: string; pid: string }> = [];

  for (const id of ids) {
    const configPath = join(agentsDir, id, "agent.yaml");
    if (!existsSync(configPath)) continue;

    let name = id;
    try {
      const raw = readFileSync(configPath, "utf-8");
      const m = raw.match(/^name:\s*(.+)$/m);
      if (m) name = m[1].trim();
    } catch {}

    // Check Flair registration
    let flairStatus = "unknown";
    try {
      const flair = createFlairClient(id, flairUrl, join(homedir(), ".tps", "identity", `${id}.key`));
      const online = await flair.ping();
      if (!online) {
        flairStatus = "offline";
      } else {
        const agent = await flair.getAgent(id);
        flairStatus = agent ? "registered" : "not registered";
      }
    } catch {
      flairStatus = "error";
    }

    // Check PID
    const pidPath = join(agentsDir, id, "run.pid");
    let pidStatus = "stopped";
    if (existsSync(pidPath)) {
      try {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        process.kill(pid, 0); // throws if not running
        pidStatus = `running (pid ${pid})`;
      } catch {
        pidStatus = "stopped (stale pid)";
      }
    }

    results.push({ id, name, flair: flairStatus, pid: pidStatus });
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.id} (${r.name})`);
      console.log(`  Flair: ${r.flair}`);
      console.log(`  Process: ${r.pid}`);
    }
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

async function agentStatus(args: AgentArgs): Promise<void> {
  const id = args.id;

  // Prevent path traversal via crafted agent IDs (e.g. "../../foo")
  if (id && (id.includes("/") || id.includes("\\") || id.includes(".."))) {
    console.error(`Invalid agent id: ${id}`);
    process.exit(1);
  }
  if (!id) {
    console.error("Usage: tps agent status --id <agent-id>");
    process.exit(1);
  }

  const homeDir = agentHomeDir();
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const agentDir = join(homeDir, ".tps", "agents", id);
  const configPath = join(agentDir, "agent.yaml");

  if (!existsSync(configPath)) {
    console.error(`Agent '${id}' not found. Run: tps agent create --id ${id}`);
    process.exit(1);
  }

  const config = loadAgentConfig(configPath);
  const rawConfig = (yaml.load(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
  const runtime = typeof rawConfig.runtime === "string" ? rawConfig.runtime : undefined;
  const out: Record<string, unknown> = { id };

  if (args.verbose) {
    out.config = {
      workspace: config.workspace,
      runtime: runtime ?? "unknown",
      model: config.llm.model,
      mailDir: config.mailDir,
    };
  }

  // Process status
  const pidPath = join(agentDir, "run.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0);
      out.process = { running: true, pid };
    } catch {
      out.process = { running: false, stalePid: true };
    }
  } else {
    out.process = { running: false };
  }

  // Flair status
  try {
    const flair = createFlairClient(id, flairUrl, join(homeDir, ".tps", "identity", `${id}.key`));
    const online = await flair.ping();
    if (!online) {
      out.flair = { online: false };
    } else {
      const agent = await flair.getAgent(id);
      const memories = await flair.listMemories(100).catch(() => []);
      out.flair = {
        online: true,
        registered: !!agent,
        memoryCount: memories.length,
      };
    }
  } catch (e) {
    out.flair = { online: false, error: String(e) };
  }

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const proc = out.process as { running: boolean; pid?: number; stalePid?: boolean };
    const flair = out.flair as { online: boolean; registered?: boolean; memoryCount?: number };
    console.log(`Agent: ${id}`);
    console.log(`Process: ${proc.running ? `running (pid ${proc.pid})` : proc.stalePid ? "stopped (stale pid)" : "stopped"}`);
    console.log(`Flair: ${flair.online ? (flair.registered ? `registered, ${flair.memoryCount} memories` : "not registered") : "offline"}`);
    if (args.verbose) {
      const verbose = out.config as { workspace: string; runtime: string; model: string; mailDir: string };
      console.log(`Workspace: ${verbose.workspace}`);
      console.log(`Runtime: ${verbose.runtime}`);
      console.log(`Model: ${verbose.model}`);
      console.log(`MailDir: ${verbose.mailDir}`);
    }
  }
}

async function decommissionAgent(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent decommission --id <agent-id> [--force]");
    process.exit(1);
  }

  if (!args.force) {
    await confirmDecommission(id);
  }

  const timestamp = Date.now().toString();
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const identityDir = join(homedir(), ".tps", "identity");
  const mailDir = join(homedir(), ".tps", "mail");
  const agentsDir = join(homedir(), ".tps", "agents");

  const keyPath = join(identityDir, `${id}.key`);
  const pubPath = join(identityDir, `${id}.pub`);
  const mailPath = join(mailDir, id);
  const agentConfigPath = join(agentsDir, id);

  const summary: Array<{ label: string; result: string }> = [];

  const flair = createFlairClient(id, flairUrl, keyPath);
  if (existsSync(keyPath)) {
    try {
      (flair as unknown as { loadKey: () => unknown }).loadKey();
    } catch (error) {
      throw new Error(`Failed to load Flair signing key for ${id}: ${String(error)}`);
    }
  }

  const archivedKey = archiveIfExists(keyPath, timestamp);
  summary.push({
    label: "Identity key",
    result: archivedKey ?? "not found",
  });

  const archivedPub = archiveIfExists(pubPath, timestamp);
  summary.push({
    label: "Identity public key",
    result: archivedPub ?? "not found",
  });

  try {
    const agent = await flair.getAgent(id);
    if (agent) {
      await flair.updateAgent(id, { status: "decommissioned" });
      summary.push({ label: "Flair agent", result: `status=decommissioned (${flairUrl})` });
    } else {
      summary.push({ label: "Flair agent", result: "not found" });
    }
  } catch (error) {
    throw new Error(`Failed to archive Flair identity for ${id}: ${String(error)}`);
  }

  const archivedMail = archiveIfExists(mailPath, timestamp);
  summary.push({
    label: "Mail dir",
    result: archivedMail ?? "not found",
  });

  const archivedConfig = archiveIfExists(agentConfigPath, timestamp);
  summary.push({
    label: "Agent config",
    result: archivedConfig ?? "not found",
  });

  console.log(`Decommissioned agent '${id}'.`);
  for (const item of summary) {
    console.log(`  ${item.label}: ${item.result}`);
  }
}

function checkAgentIdentity(agentId: string): AgentHealthcheckResult {
  const configPath = join(healthcheckHomeDir(), ".tps", "agents", agentId, "agent.yaml");
  try {
    readFileSync(configPath, "utf-8");
    return {
      label: "Identity",
      pass: true,
      detail: `~/.tps/agents/${agentId}/agent.yaml`,
    };
  } catch {
    return {
      label: "Identity",
      pass: false,
      detail: `~/.tps/agents/${agentId}/agent.yaml unreadable or missing`,
    };
  }
}

async function checkAgentFlairAuth(agentId: string, flairUrl?: string): Promise<AgentHealthcheckResult> {
  const baseUrl = flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const keyPath = join(healthcheckHomeDir(), ".tps", "identity", `${agentId}.key`);

  try {
    const flair = createFlairClient(agentId, baseUrl, keyPath);
    await flair.search("healthcheck", 1);
    return {
      label: "Flair auth",
      pass: true,
      detail: `authenticated as ${agentId}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      label: "Flair auth",
      pass: false,
      detail: message,
    };
  }
}

function checkAgentProcess(agentId: string): AgentHealthcheckResult {
  const pidPath = join(healthcheckHomeDir(), "ops", `tps-${agentId}`, ".tps-agent.pid");

  if (!existsSync(pidPath)) {
    return {
      label: "Process",
      pass: false,
      detail: "no PID file found",
    };
  }

  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (Number.isNaN(pid)) {
      return {
        label: "Process",
        pass: false,
        detail: `invalid PID file: ~/ops/tps-${agentId}/.tps-agent.pid`,
      };
    }
    process.kill(pid, 0);
    return {
      label: "Process",
      pass: true,
      detail: `PID ${pid} running`,
    };
  } catch {
    return {
      label: "Process",
      pass: false,
      detail: `stale PID file: ~/ops/tps-${agentId}/.tps-agent.pid`,
    };
  }
}

function checkAgentMailDir(agentId: string): AgentHealthcheckResult {
  const mailPath = join(healthcheckHomeDir(), ".tps", "mail", agentId, "new");

  if (!existsSync(mailPath)) {
    return {
      label: "Mail dir",
      pass: false,
      detail: `~/.tps/mail/${agentId}/new missing`,
    };
  }

  try {
    accessSync(mailPath, constants.W_OK);
    return {
      label: "Mail dir",
      pass: true,
      detail: `~/.tps/mail/${agentId}/new (writable)`,
    };
  } catch {
    return {
      label: "Mail dir",
      pass: false,
      detail: `~/.tps/mail/${agentId}/new not writable`,
    };
  }
}

export async function healthcheckAgent(args: AgentArgs): Promise<void> {
  const agentId = args.id;
  if (!agentId) {
    console.error("Usage: tps agent healthcheck <agent-id>");
    process.exit(1);
  }

  const checks: AgentHealthcheckResult[] = [
    checkAgentIdentity(agentId),
    await checkAgentFlairAuth(agentId, args.flairUrl),
    checkAgentProcess(agentId),
    checkAgentMailDir(agentId),
  ];

  if (args.json) {
    console.log(JSON.stringify({ agentId, ok: checks.every((check) => check.pass), checks }, null, 2));
  } else {
    for (const check of checks) {
      const prefix = check.pass ? "PASS " : "FAIL ";
      console.log(`${prefix} ${check.label}: ${check.detail}`);
    }
  }

  if (checks.some((check) => !check.pass)) {
    process.exit(1);
  }
}
// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runAgent(args: AgentArgs): Promise<void> {
  switch (args.action) {
    case "create":
      return createAgent(args);

    case "list":
      return listAgents(args);

    case "status":
      return agentStatus(args);

    case "decommission":
      return decommissionAgent(args);

    case "commit":
      return commitAgentChanges(args);

    case "isolate":
      return isolateAgent(args);

    case "logs":
      return logAgentRuntime(args);

    case "healthcheck":
      return healthcheckAgent(args);

    case "run":
    case "start":
    case "health": {
      // Resolve config path — support --id shorthand
      let configPath = args.config;
      if (!configPath && args.id) {
        configPath = join(homedir(), ".tps", "agents", args.id, "agent.yaml");
      }
      if (!configPath) {
        console.error("Usage: tps agent run --id <agent-id> --message <text>");
        console.error("   or: tps agent run --config <path> --message <text>");
        process.exit(1);
      }
      // Resolve relative --config before reading or re-executing (cli#516).
      configPath = resolvePathMod(configPath);
      if (!existsSync(configPath)) {
        console.error(`Config not found: ${configPath}`);
        console.error(`Run 'tps agent create --id ${args.id ?? "<id>"}' first.`);
        process.exit(1);
      }

      const config = loadAgentConfig(configPath);
      config.workspace = agentWorkspace(configPath, config.workspace, args.sandboxed ? process.env : undefined);

      // cli#351 r5 — the launch grant must NOT come from a file the sandboxed
      // workload can rewrite (`agentDir` is granted r+w, so the agent can edit
      // its own agent.yaml). Derive it from the validated `--id`, and require
      // the config to agree (a config that disagrees is tampered or misbuilt).
      // Charset + traversal check mirrors agentStatus's, via the wire-mail
      // SAFE_ID shape.
      const launchId = args.id ?? config.agentId;
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(launchId) || launchId.includes("..")) {
        console.error(
          `Invalid agent id (${args.id ? "--id" : "config.agentId"}): ${launchId} — must match ^[a-zA-Z0-9._-]{1,64}$ and contain no traversal`,
        );
        process.exit(1);
      }
      if (args.id && config.agentId !== args.id) {
        console.error(
          `❌ agent.yaml agentId '${config.agentId}' does not match the launch id '${args.id}' — refusing to launch (cli#351 r5)`,
        );
        process.exit(1);
      }
      // The runtime's own key resolution (this same value) is now the validated id.
      config.agentId = launchId;
      const createRuntime = () => {
        if (config.flair) {
          const flair = createFlairClient(
            config.agentId,
            config.flair.url ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926",
            config.flair.keyPath ?? join(homedir(), ".tps", "identity", `${config.agentId}.key`),
          );
          loadPlugins({ slots: { memory: "flair" } }, { flair });
        }
        if (config.role) {
          applyRole({ role: config.role, ...(config.roleConfig ?? {}) }, config.agentId);
        }
        return new AgentRuntime(config);
      };

      if (args.action === "run") {
        const message = args.message || process.env.TPS_AGENT_MESSAGE;
        if (!message) {
          console.error("Usage: tps agent run --id <agent-id> --message <text>");
          process.exit(1);
        }
        await createRuntime().runOnce(message);
        return;
      }

      if (args.action === "start") {
        const sandbox = (args as any).sandbox ?? true; // default ON — nono is the required isolation layer
        const sandboxed = (args as any).sandboxed ?? false;
        const sandboxRequired = (args as any).sandboxRequired ?? process.argv.includes("--sandbox-required");
        // cli#363 slice B: carry the selected runtime into the re-exec so the
        // sandboxed child runs the runtime runner rather than the default
        // AgentRuntime. Its CLI caller selects only those three runtimes.
        const selectedRuntime = args.runtime;
        // The pinned ABSOLUTE path (never PATH) — the same resolution the
        // launcher performs, so the decision to launch and the launch itself
        // cannot disagree about which nono is in play (cli#350 round 4e). Using
        // the pinned resolution here too (cli#350 r4g) means a PATH-only nono
        // cannot make this look available and then skip the actionable
        // "Install nono >= 0.70 or set NONO_BIN" refusal below.
        const nonoAvailable = resolveNonoBinary().bin;

        if (sandboxed) {
          // Already inside the launcher's nono session — skip re-exec, proceed
          // to runtime. Whether that claim is TRUE was settled by the gate: this
          // process only reaches here holding the launcher's release
          // (cli#350 round 4e).
        } else if (sandbox || selectedRuntime || isNonoStrict()) {
          if (!nonoAvailable) {
            if (selectedRuntime || isNonoStrict() || sandboxRequired || !isInteractiveTty()) {
              const why = selectedRuntime
                ? `runtime '${selectedRuntime}' requires isolation; use --no-sandbox in an interactive TTY to opt out`
                : isNonoStrict()
                  ? "TPS_NONO_STRICT=1"
                  : "this launch is not interactive";
              console.error(
                `❌ refusing to launch ${selectedRuntime ? `runtime '${selectedRuntime}'` : "the agent"}: no nono at the pinned absolute path ` +
                  `(${resolveNonoBinary().reason ?? "unknown"}) — ${why}, so the agent cannot ` +
                  `run without isolation. Install nono >= 0.70 or set NONO_BIN.`
              );
              process.exit(isSupervised() ? SUPERVISED_REFUSAL_EXIT_CODE : REFUSAL_EXIT_CODE);
            }
            console.warn("⚠️  nono not found — starting WITHOUT sandbox isolation. Pass --sandbox after installing nono.");
          } else {
            // Re-exec this process under nono with tps-agent-run profile
            const mailDir = join(homedir(), ".tps", "mail");
            const agentDir = join(homedir(), ".tps", "agents", launchId);
            const tmpDir = process.env.TMPDIR ?? "/tmp";
            // Carry the launch-control assertion verbatim into the re-exec child.
            // The child is a non-TTY context too: if it does not carry
            // --sandbox-required it refuses itself, and under TPS_SUPERVISED=1
            // that refusal exits 0 — launchd sees success and KeepAlive
            // {SuccessfulExit:false} never relaunches, so the agent silently
            // never starts. (cli#350 fix-round, Sherlock.)
            const relaunch = [
              process.execPath,
              ...process.execArgv,
              process.argv[1]!,
              "agent",
              "start",
              "--id",
              config.agentId,
              "--sandboxed",
            ];
            if (sandboxRequired) relaunch.push("--sandbox-required");
            // Carry the runtime through the attested launch (cli#363 slice B):
            // the sandboxed child re-enters bin/tps.ts, which runs the runtime
            // runner on the execution side.
            if (selectedRuntime) relaunch.push("--runtime", selectedRuntime);
            // Carry the resolved config pathname through the re-exec (cli#516).
            // The child gets the canonical path, the same file the read-file
            // grant names: macOS Seatbelt checks a symlink's own path, so a
            // child opening the link would be denied a file it may read.
            relaunch.push("--config", canonicalPath(configPath));
            // THE ATTESTED LAUNCH (cli#350 round 4e): the launcher creates the
            // private dir, plants the canaries, spawns nono by absolute path,
            // and releases the child over its own socket only after `nono ps`
            // binds a live session to the pid it spawned and to the pid the
            // child reports, with the OUTSIDE canary still unreadable to it.
            const profile = runtimeNonoProfile(selectedRuntime);
            const launchInput = {
              configPath,
              cwd: process.cwd(),
              workspace: config.workspace,
              launchId,
              runtime: selectedRuntime,
              mailDir,
              tmpDir,
              agentDir,
            };
            const approveLaunch = () => {
              const result = agentLaunchOptions(launchInput);
              if (result.refusal) throw new Error(`refusing to launch runtime '${selectedRuntime ?? "AgentRuntime"}': ${result.refusal}`);
              return result;
            };
            const { onStart, onStop } = await import("../utils/agent-lifecycle.js");
            let worktreeCreated = false;
            let approval: ReturnType<typeof agentLaunchOptions>;
            try {
              approval = approveLaunch();
              const profileRefusal = sandboxProfileGrantRefusal(profile, process.env, selectedRuntime, nonoAvailable);
              if (profileRefusal) throw new Error(`refusing to launch profile '${profile}': ${profileRefusal}`);
              const start = selectedRuntime ? onStart(launchId, config.workspace, { deferCheckout: true }) : undefined;
              worktreeCreated = start?.changed ?? false;
              approval = approveLaunch();
            } catch (err) {
              console.error(`❌ ${(err as Error).message}`);
              if (worktreeCreated) {
                try {
                  onStop(launchId, config.workspace);
                } catch (cleanupErr) {
                  console.error(`❌ ${(cleanupErr as Error).message}`);
                }
              }
              process.exit(isSupervised() ? SUPERVISED_REFUSAL_EXIT_CODE : REFUSAL_EXIT_CODE);
            }
            // The child checks the worktree out only when THIS launch created
            // it. Remove any inherited TPS_WORKTREE_PENDING before launch and
            // set it only after a worktree was actually created, so an
            // inherited value never names someone else's worktree (cli#516).
            const launchEnv: NodeJS.ProcessEnv = { ...process.env };
            launchEnv.TPS_AGENT_WORKSPACE = config.workspace;
            delete launchEnv.TPS_WORKTREE_PENDING;
            if (worktreeCreated) launchEnv.TPS_WORKTREE_PENDING = config.workspace;
            let exitCode: number;
            try {
              exitCode = await launchAttested(
                profile,
                approval.options,
                relaunch,
                {
                  runtimeDirectories: approval.runtimeDirectories,
                  env: launchEnv,
                },
              );
            } finally {
              // Attempt cleanup only after this launch created a worktree (cli#516).
              if (worktreeCreated) {
                try {
                  onStop(launchId, config.workspace);
                } catch (err) {
                  console.error(`❌ ${(err as Error).message}`);
                  process.exit(isSupervised() ? SUPERVISED_REFUSAL_EXIT_CODE : REFUSAL_EXIT_CODE);
                }
              }
            }
            process.exit(exitCode);
          }
        } else if (!sandboxed && nonoAvailable) {
          console.log(`ℹ️  nono available — pass --sandbox to run with isolation`);
        }

        try {
          await createRuntime().start();
        } catch (_err) {
          console.error("❌ Agent runtime crashed:", _err);
          process.exit(1);
        }
        return;
      }

      if (args.action === "health") {
        const healthy = createRuntime().isHealthy();
        process.stdout.write(healthy ? "healthy\n" : "unhealthy\n");
        process.exit(healthy ? 0 : 1);
      }
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown agent action: ${_}`);
      process.exit(1);
    }
  }
}

// ─── agent commit ─────────────────────────────────────────────────────────────

const SAFE_GIT_REF_RE = /^[a-zA-Z0-9._/-]+$/;
const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function failWith(message: string, exitCode = 1): never {
  console.error(message);
  process.exit(exitCode);
}

function isWithinDir(root: string, target: string): boolean {
  const rel = require("node:path").relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; status: number } {
  const { spawnSync } = require("node:child_process");
  // Use /usr/bin/git directly to bypass the codex-tools git wrapper
  // (the wrapper blocks commit/push for sandboxed agents, but tps agent commit is the runtime)
  const gitBin = process.env.TPS_GIT_BIN ?? "/usr/bin/git";
  const r = spawnSync(gitBin, args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? 1 };
}

function runGitOrFail(args: string[], cwd: string, label: string): string {
  const r = runGit(args, cwd);
  if (!r.ok) failWith(`${label} failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  return r.stdout;
}


function getMostRecentTaskMailBody(agentId: string) {
  const mailDir = join(homedir(), ".tps", "mail", agentId, "cur");
  if (!existsSync(mailDir)) return null;
  const files = readdirSync(mailDir);
  if (files.length === 0) return null;
  const sorted = files
    .map(f => ({ f, mtime: statSync(join(mailDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const latestFile = join(mailDir, sorted[0].f);
  const raw = readFileSync(latestFile, "utf-8");
  try {
    const mail = JSON.parse(raw);
    return mail.body || null;
  } catch {
    return raw;
  }
}

function countFilesInText(text: string, repoRoot: string) {
  const repoRootNorm = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  const lines = text.split("\n");
  const paths = new Set();
  const extRe = /\.[a-zA-Z0-9]+$/;
  for (const line of lines) {
    const tokens = line.trim().split(/\\s+/);
    for (let token of tokens) {
      token = token.replace(/^[.,:;!?"`']+|[.,:;!?"`']+$/g, "");
      if (!token) continue;
      if (token.startsWith(repoRootNorm)) { paths.add(token); continue; }
      if (token.startsWith("./") || token.startsWith("../")) {
        const resolved = resolvePathMod(repoRoot, token);
        if (resolved.startsWith(repoRoot)) paths.add(resolved);
        continue;
      }
      if (extRe.test(token) && !token.includes("/")) {
        const resolved = resolvePathMod(repoRoot, token);
        if (resolved.startsWith(repoRoot)) paths.add(resolved);
        continue;
      }
      if (token.includes("/") && token.includes(".") && !token.startsWith("http://") && !token.startsWith("https://")) {
        const resolved = resolvePathMod(repoRoot, token);
        if (resolved.startsWith(repoRoot)) paths.add(resolved);
      }
    }
  }
  return paths.size;
}
async function commitAgentChanges(args: AgentArgs): Promise<void> {
  const { repo, branchName, commitMessage, authorName, authorEmail, paths, push: doPush, prTitle } = args;

  if (!repo || !branchName || !commitMessage || !authorName || !authorEmail) {
    failWith("Usage: tps agent commit --repo <path> --branch <name> --message <msg> --author <name> <email> [--path <file>] [--push] [--pr-title <title>] [--ack-scope-expansion] [--scope-warn-threshold <factor>]");
  }
  if (!SIMPLE_EMAIL_RE.test(authorEmail!)) failWith(`Invalid author email: ${authorEmail}`);
  if (branchName!.startsWith("-") || !SAFE_GIT_REF_RE.test(branchName!)) failWith(`Invalid branch name: ${branchName}`);

  const { resolve: resolvePath, relative: relativePath } = require("node:path");
  const { existsSync: exists } = require("node:fs");
  const repoPath = resolvePath(repo!);
  if (!exists(repoPath)) failWith(`Repository path not found: ${repoPath}`);
  if (!repoPath.startsWith("/")) failWith("Repository path must be absolute.");
  const gitCheck = runGit(["rev-parse", "--is-inside-work-tree"], repoPath);
  if (!gitCheck.ok || gitCheck.stdout !== "true") failWith(`Not a git repository: ${repoPath}`);

  // Scope expansion guardrail (ops-43zd)
  const scopeAgentId = requireLocalAgentId("agent commit agent id");
  const taskMailBody = getMostRecentTaskMailBody(scopeAgentId);
  if (taskMailBody !== null) {
    const hintFileCount = countFilesInText(taskMailBody, repoPath);
    const scopeThresholdFactor = args.scopeWarnThreshold
      ?? (process.env.TPS_SCOPE_WARN_THRESHOLD ? parseInt(process.env.TPS_SCOPE_WARN_THRESHOLD, 10) : undefined)
      ?? 3;
    let filesToStageCount = 0;
    if (args.paths && args.paths.length > 0) {
      const pathSet = new Set();
      for (const p of args.paths) {
        const abs = resolvePath(repoPath, p);
        if (isWithinDir(repoPath, abs)) pathSet.add(abs);
      }
      filesToStageCount = pathSet.size;
    } else {
      const diff = runGit(["diff", "--name-only"], repoPath);
      const diffFiles = diff.status === 0 && diff.stdout ? diff.stdout.split("\n").filter(Boolean) : [];
      const untracked = runGit(["ls-files", "--others", "--exclude-standard"], repoPath);
      const untrackedFiles = untracked.status === 0 && untracked.stdout ? untracked.stdout.split("\n").filter(Boolean) : [];
      filesToStageCount = new Set([...diffFiles, ...untrackedFiles]).size;
    }
    if (hintFileCount > 0 && filesToStageCount > hintFileCount * scopeThresholdFactor) {
      const warning = `SCOPE EXPANSION DETECTED — original task hinted at ${hintFileCount} files; diff touches ${filesToStageCount} files. Continue with --ack-scope-expansion or revise.`;
      if (!args.ackScopeExpansion) {
        console.error(warning);
        process.exit(1);
      }
      console.warn("\u26a0\ufe0f  " + warning);
    }
  }

  // Create or checkout branch
  const branchExists = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoPath).ok;
  if (branchExists) {
    runGitOrFail(["checkout", branchName!], repoPath, `checkout ${branchName}`);
  } else {
    runGitOrFail(["checkout", "-b", branchName!], repoPath, `create branch ${branchName}`);
  }

  // Stage changes
  if (paths && paths.length > 0) {
    const safePaths = paths.map((p) => {
      const abs = resolvePath(repoPath, p);
      if (!isWithinDir(repoPath, abs)) failWith(`Path escapes repo: ${p}`);
      return relativePath(repoPath, abs) || ".";
    });
    runGitOrFail(["add", "--", ...safePaths], repoPath, "git add");
  } else {
    runGitOrFail(["add", "-A"], repoPath, "git add -A");
  }

  const diff = runGit(["diff", "--cached", "--quiet"], repoPath);
  if (diff.status === 0) {
    // Nothing staged — check if HEAD is already ahead of origin (agent self-committed)
    // Note: origin/<branch> may not exist yet if this is the first push.
    const refExists = runGit(["rev-parse", "--verify", `refs/remotes/origin/${branchName!}`], repoPath).ok;
    let aheadCount = 0;
    if (refExists) {
      const ahead = runGit(["rev-list", "--count", `origin/${branchName!}..HEAD`], repoPath);
      aheadCount = parseInt((ahead.stdout ?? "").trim(), 10);
    } else {
      // Branch not yet pushed — count local commits; any commit means already committed
      const localCommits = runGit(["rev-list", "--count", "HEAD"], repoPath);
      const localCount = parseInt((localCommits.stdout ?? "").trim(), 10);
      aheadCount = Number.isNaN(localCount) ? 0 : localCount;
    }
    if (Number.isNaN(aheadCount) || aheadCount === 0) {
      failWith("No changes staged for commit.");
    }
    // Already committed — skip to push
    console.log(`Changes already committed on ${branchName}. Skipping commit step.`);
  } else {
    runGitOrFail(["commit", "--author", `${authorName} <${authorEmail}>`, "-m", commitMessage!], repoPath, "git commit");
    console.log(`Committed changes in ${repoPath} on branch ${branchName}.`);
  }

  if (!doPush) return;

  runGitOrFail(["push", "-u", "origin", branchName!], repoPath, "git push");
  console.log(`Pushed ${branchName} to origin.`);

  // Open PR via gh-as
  const agentHandle = authorEmail!.split("@")[0] ?? "";
  const title = prTitle ?? commitMessage!;
  const { spawnSync } = require("node:child_process");
  const pr = spawnSync("gh-as", [agentHandle, "pr", "create", "--title", title, "--body", commitMessage!, "--head", branchName!], { cwd: repoPath, encoding: "utf-8" });
  if (pr.status !== 0) {
    const prErr = pr.stderr?.trim() ?? pr.stdout?.trim() ?? "unknown error";
    console.warn(`[tps agent commit] PR creation failed: ${prErr}`);
    console.warn(`[tps agent commit] Branch ${branchName} was pushed — open PR manually with: gh pr create --head ${branchName}`);
    // Exit non-zero so callers (auto-commit) can detect and log the failure
    process.exit(2);
  } else {
    console.log(`PR opened: ${pr.stdout?.trim()}`);
  }
}

// ─── agent isolate ────────────────────────────────────────────────────────────

async function isolateAgent(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent isolate --id <agent-id> [--port <gateway-port>]");
    process.exit(1);
  }

  const ocHome = join(homedir(), `.openclaw-${id}`);
  const srcJson = join(homedir(), ".openclaw", "openclaw.json");
  const dstJson = join(ocHome, "openclaw.json");

  if (!existsSync(srcJson)) {
    console.error(`OpenClaw config not found at ${srcJson}`);
    process.exit(1);
  }

  mkdirSync(ocHome, { recursive: true });

  // Read source config
  const src = JSON.parse(readFileSync(srcJson, "utf-8"));

  // Extract just this agent's entry
  const agentList: any[] = src.agents?.list ?? [];
  const agentEntry = agentList.find((a: any) => a.id === id);
  if (!agentEntry) {
    console.error(`Agent '${id}' not found in OpenClaw config.`);
    process.exit(1);
  }

  // Build isolated config — minimal subset, single agent
  const port = args.port ?? 18800 + Math.floor(Math.random() * 100);
  const isolated = {
    meta: src.meta ?? {},
    wizard: { completed: true },
    secrets: {},
    auth: {},
    models: src.models ?? {},
    agents: {
      defaults: src.agents?.defaults ?? {},
      list: [agentEntry],
    },
    bindings: {},
    messages: {},
    commands: {},
    channels: src.channels ?? {},
    gateway: { port },
    plugins: src.plugins ?? {},
  };

  writeFileSync(dstJson, JSON.stringify(isolated, null, 2), "utf-8");

  console.log(`\nAgent '${id}' isolated at: ${ocHome}`);
  console.log(`Gateway port: ${port}`);
  console.log(`\nTo start the isolated gateway:`);
  console.log(`  OPENCLAW_HOME=${ocHome} openclaw gateway start`);
  console.log(`\nAdd to ~/.tps/agents/${id}/agent.yaml:`);
  console.log(`  openclawHome: ${ocHome}`);
  console.log(`  openclawPort: ${port}`);
}
