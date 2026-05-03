/**
 * tps secrets rotate-github-pat <agent>
 * tps secrets list-github-pats
 *
 * GitHub PAT rotation with safety properties:
 *   - No positional token arg, no --token-from flag → token never reaches argv,
 *     shell history, or transient files Claude/operators might `cat`.
 *   - Token comes from stdin: pipe (`cat pat | tps ...`) or interactive
 *     silent-read prompt.
 *   - Pre-validate shape, then HTTP 200 probe BEFORE overwriting any file.
 *     A failed probe leaves the existing PAT untouched.
 *   - Atomic write: tmp file + rename, mode 600.
 *   - Final post-rotation verify.
 *   - For the keyring agent (`flint`): pipe to `gh auth login --with-token`
 *     instead of writing a file.
 *
 * See ops-njgl for the design rationale.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import * as readline from "node:readline";

const SECRETS_DIR = resolve(homedir(), ".tps", "secrets");

// Agents whose PAT lives in the macOS keychain via `gh auth login`
// (not in a file). Currently only `flint` — the gh-as helper resolves
// `flint` PAT through the keyring, not a file.
const KEYRING_AGENTS = new Set(["flint"]);

// ─── Validation helpers (pure, exported for tests) ───────────────────────────

/** Strip surrounding whitespace + a trailing newline. Useful when a token
 * is pasted with a stray Enter, or piped from `echo $X` which adds \n. */
export function normalizeToken(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, "");
}

/** GitHub fine-grained PAT prefix is `github_pat_`. Classic PATs start with
 * `ghp_` (rarely used by us — public_repo scope is one). Either is acceptable.
 *
 * Length check: GitHub fine-grained PATs are 93 chars; classic are 40. We
 * accept anything in [40, 256] as a sanity range to catch obvious paste
 * mishaps (truncation, accidental rest-of-clipboard).
 */
export function validateTokenShape(token: string): string | null {
  if (!token) return "empty token";
  if (token.length < 40) return `token too short (${token.length} chars; expected ≥ 40)`;
  if (token.length > 256) return `token too long (${token.length} chars; check for accidental clipboard contents)`;
  if (!/^(github_pat_|ghp_|ghs_|gho_)/.test(token)) return "token must start with a recognized GitHub PAT prefix (github_pat_, ghp_, ghs_, gho_)";
  // No spaces, no newlines, no quotes — basic sanity
  if (/[\s'"`]/.test(token)) return "token contains unexpected whitespace or quotes (paste mishap?)";
  return null;
}

/** GitHub /user probe — returns true on 200, false on anything else. Doesn't
 * print the token anywhere. Times out at 5s. */
export async function probeToken(token: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; login?: string }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, "User-Agent": "tps-secrets-rotate" },
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => null) as { login?: string } | null;
    return { ok: true, status: 200, login: data?.login };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─── Stdin handling ──────────────────────────────────────────────────────────

/** Read one line of input from stdin without echoing (TTY) or pipe-style
 * (non-TTY). Used for the rotate-github-pat token input. */
async function readTokenFromStdin(prompt: string): Promise<string> {
  const isTTY = process.stdin.isTTY;
  if (!isTTY) {
    // Pipe mode: read all stdin
    return await new Promise<string>((res) => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => { buf += chunk; });
      process.stdin.on("end", () => res(buf));
    });
  }
  // TTY mode: silent-prompt
  return await new Promise<string>((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Mute echo: override _writeToOutput to suppress char-by-char display
    const wt = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = (str: string) => {
      // Allow our prompt + newline; suppress everything else (chars + backspaces)
      if (str.includes(prompt) || str === "\r\n" || str === "\n") {
        if ((rl as any).output) (rl as any).output.write(str);
      }
    };
    rl.question(prompt, (answer) => {
      (rl as any)._writeToOutput = wt;
      rl.close();
      process.stderr.write("\n"); // visual completion of the prompt line
      res(answer);
    });
  });
}

// ─── File-based rotation ─────────────────────────────────────────────────────

function patFilePath(agent: string): string {
  // Sanitize: only allow [a-z0-9_-]+ for agent name (defense-in-depth — also a
  // path-traversal guard since agent flows into resolve()).
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    throw new Error(`invalid agent name: ${agent}`);
  }
  return resolve(SECRETS_DIR, `${agent}-github-pat`);
}

async function rotateFilePat(agent: string, token: string): Promise<void> {
  const path = patFilePath(agent);
  const tmp = path + ".tmp." + process.pid;
  // Ensure parent dir exists (~/.tps/secrets/)
  if (!existsSync(dirname(path))) {
    throw new Error(`secrets dir missing: ${dirname(path)} — run \`tps identity init\` first`);
  }
  // Atomic write: tmp + rename
  writeFileSync(tmp, token, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function rotateKeyringPat(agent: string, token: string): Promise<void> {
  // `gh auth login --with-token` reads the token from stdin (no argv leak).
  // We pass the token via stdin to gh-as <agent>.
  const result = spawnSync("gh-as", [agent, "auth", "login", "--with-token"], {
    input: token,
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`gh-as ${agent} auth login failed: ${result.stderr || result.stdout}`);
  }
}

// ─── Public command entry points ─────────────────────────────────────────────

export async function runRotateGithubPat(agent: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    console.error(`Error: invalid agent name '${agent}'`);
    process.exit(1);
  }

  const isKeyring = KEYRING_AGENTS.has(agent);
  const target = isKeyring ? "keyring (gh auth login)" : `file ${patFilePath(agent)}`;
  process.stderr.write(`Rotating GitHub PAT for ${agent} → ${target}\n`);

  const prompt = "Paste new PAT (input hidden, press Enter to submit): ";
  const raw = await readTokenFromStdin(prompt);
  const token = normalizeToken(raw);

  // (1) Shape validation — fast-fail before any network or filesystem touch
  const shapeErr = validateTokenShape(token);
  if (shapeErr) {
    console.error(`Error: ${shapeErr}`);
    process.exit(1);
  }

  // (2) Pre-write probe — confirm the token actually works before clobbering
  process.stderr.write("Probing GitHub /user with new token...\n");
  const probe = await probeToken(token);
  if (!probe.ok) {
    console.error(`Error: pre-rotation probe failed (HTTP ${probe.status}). Existing PAT left untouched.`);
    process.exit(1);
  }
  process.stderr.write(`  ✓ probe: 200 OK (login: ${probe.login ?? "?"})\n`);

  // (3) Rotate the value
  try {
    if (isKeyring) {
      await rotateKeyringPat(agent, token);
    } else {
      await rotateFilePat(agent, token);
    }
  } catch (err: any) {
    console.error(`Error: rotation failed: ${err.message}`);
    process.exit(1);
  }

  // (4) Post-rotation verify (re-read from where it actually lives)
  let verifyToken = token;
  if (!isKeyring) {
    try {
      verifyToken = readFileSync(patFilePath(agent), "utf-8");
    } catch (err: any) {
      console.error(`Warning: post-rotation re-read failed: ${err.message}`);
    }
  } else {
    // For keyring, verify via gh-as <agent> api user (not by re-reading the token)
    const ghVerify = spawnSync("gh-as", [agent, "api", "user", "--jq", ".login"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (ghVerify.status !== 0) {
      console.error(`Error: post-rotation gh-as ${agent} verify failed: ${ghVerify.stderr || ghVerify.stdout}`);
      process.exit(1);
    }
    process.stderr.write(`  ✓ post-rotation verify (keyring): ${ghVerify.stdout.trim()}\n`);
    process.stderr.write(`\nrotated ${agent}; verify all with: tps secrets list-github-pats\n`);
    return;
  }

  const verify = await probeToken(verifyToken);
  if (!verify.ok) {
    console.error(`Error: post-rotation probe failed (HTTP ${verify.status}). Token written but doesn't auth — investigate.`);
    process.exit(1);
  }
  process.stderr.write(`  ✓ post-rotation probe: 200 OK\n`);
  process.stderr.write(`\nrotated ${agent}; verify all with: tps secrets list-github-pats\n`);
}

export async function runListGithubPats(opts: { json?: boolean } = {}): Promise<void> {
  if (!existsSync(SECRETS_DIR)) {
    console.error(`Error: secrets dir missing: ${SECRETS_DIR}`);
    process.exit(1);
  }

  const { readdirSync } = await import("node:fs");
  const files = readdirSync(SECRETS_DIR).filter((f) => f.endsWith("-github-pat") || f.includes("-github-pat-"));

  type Result = { source: string; status: number; ok: boolean; login?: string; mtime?: string };
  const results: Result[] = [];

  for (const f of files) {
    const path = resolve(SECRETS_DIR, f);
    let token = "";
    try { token = readFileSync(path, "utf-8").replace(/\s+$/, ""); } catch { continue; }
    if (!token) {
      results.push({ source: f, status: 0, ok: false });
      continue;
    }
    const probe = await probeToken(token);
    let mtime: string | undefined;
    try { mtime = statSync(path).mtime.toISOString(); } catch { /* ignore */ }
    results.push({ source: f, status: probe.status, ok: probe.ok, login: probe.login, mtime });
  }

  // Probe keyring agents via gh-as
  for (const agent of KEYRING_AGENTS) {
    const ghVerify = spawnSync("gh-as", [agent, "api", "user", "--jq", ".login"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (ghVerify.status === 0) {
      results.push({ source: `${agent} (keyring)`, status: 200, ok: true, login: ghVerify.stdout.trim() });
    } else {
      results.push({ source: `${agent} (keyring)`, status: 0, ok: false });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Text table
  const sourceWidth = Math.max(20, ...results.map((r) => r.source.length));
  console.log(`  ${"source".padEnd(sourceWidth)}  status  login`);
  for (const r of results) {
    const statusLabel = r.ok ? `${r.status}` : `${r.status || "—"} ❌`;
    const login = r.login ?? (r.ok ? "?" : "—");
    console.log(`  ${r.source.padEnd(sourceWidth)}  ${statusLabel.padEnd(6)}  ${login}`);
  }

  const failing = results.filter((r) => !r.ok);
  if (failing.length > 0) {
    console.log(`\n${failing.length} of ${results.length} PAT${failing.length > 1 ? "s" : ""} failed probe.`);
    console.log(`Rotate via: tps secrets rotate-github-pat <agent>`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} PATs auth OK.`);
  }
}
