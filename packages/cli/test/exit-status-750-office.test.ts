// cli#750 — `tps office join --tunnel-via` reports failed Flair spoke and
// supervision provisioning through its exit status. Each test drives the real
// command against a local Noise_IK listener so the join itself succeeds.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprint, generateKeyPair, registerBranch, saveToVault } from "../src/utils/identity.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const AGENT = "agent-a";
const VAULT_KEY = "exit-status-750-test-pass";

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no address"));
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
    server.once("error", reject);
  });
}

let home: string;
let fakeBin: string;
let server: { close: () => Promise<void> } | undefined;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tps-exit-750-office-"));
  fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "launchctl"),
    "#!/usr/bin/env bash\nexit 0\n",
    "utf-8",
  );
  writeFileSync(
    join(fakeBin, "ssh"),
    `#!/usr/bin/env bash
# Args: -- <host> <command...>
cmd="\${*:3}"
case "$cmd" in
  "exit 0") exit "\${FAKE_SSH_EXIT:-0}" ;;
  *"test -d ~/.flair"*) echo "\${FAKE_FLAIR_PRESENT:-NO}"; exit 0 ;;
  "uname -s") [ "\${FAKE_UNAME_FAIL:-0}" = "1" ] && exit 1; echo "Linux"; exit 0 ;;
  *"systemctl --user is-enabled"*) echo "NOT_FOUND"; exit 0 ;;
  "printf '%s' \\"\\$HOME\\"") echo "/home/agent-a"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    "utf-8",
  );
  writeFileSync(
    join(fakeBin, "openssl"),
    '#!/usr/bin/env bash\necho "dGVzdC1hZG1pbi1wYXNz"\n',
    "utf-8",
  );
  chmodSync(join(fakeBin, "launchctl"), 0o755);
  chmodSync(join(fakeBin, "ssh"), 0o755);
  chmodSync(join(fakeBin, "openssl"), 0o755);

  savedEnv = {
    HOME: process.env.HOME,
    TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR,
    TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
    TPS_VAULT_KEY: process.env.TPS_VAULT_KEY,
  };

  const branchKp = generateKeyPair();
  const hostKp = generateKeyPair();
  const identityDir = join(home, ".tps", "identity");
  process.env.HOME = home;
  process.env.TPS_IDENTITY_DIR = identityDir;
  process.env.TPS_VAULT_KEY = VAULT_KEY;
  const now = Date.now();
  await saveToVault({
    identity: {
      seed: Buffer.from(branchKp.seed).toString("base64"),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    },
    secrets: {},
  });

  const registryDir = join(home, "host-registry");
  process.env.TPS_REGISTRY_DIR = registryDir;
  registerBranch(AGENT, branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);

  const port = await freePort();
  server = await new NoiseIkTransport(hostKp, hostKp).listen(port);
  const token = [
    "tps://join?",
    "host=127.0.0.1",
    `&port=${port}`,
    "&transport=tcp",
    `&pubkey=${Buffer.from(hostKp.encryption.publicKey).toString("base64url")}`,
    `&sigpubkey=${Buffer.from(hostKp.signing.publicKey).toString("base64url")}`,
    `&fp=sha256:${fingerprint(hostKp.signing.publicKey)}`,
  ].join("");
  process.env.TPS_JOIN_TOKEN = token;
});

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.TPS_JOIN_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

async function runJoin(env: Record<string, string> = {}): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(
    [
      "bun",
      TPS_BIN,
      "office",
      "join",
      AGENT,
      process.env.TPS_JOIN_TOKEN ?? "",
      "--tunnel-via",
      "host-a",
      ...(env.NO_FLAIR === "1" ? ["--no-flair"] : []),
    ],
    {
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: home,
        TMPDIR: home,
        TPS_IDENTITY_DIR: join(home, ".tps", "identity"),
        TPS_VAULT_KEY: VAULT_KEY,
        ...env,
      },
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

describe("cli#750 — `tps office join` exits non-zero when provisioning fails", () => {
  test("supervision provisioning failure exits 1", async () => {
    const result = await runJoin({ FAKE_SSH_EXIT: "1", NO_FLAIR: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Supervision provisioning failed");
  });

  test("a blocked Flair spoke plan exits 1", async () => {
    mkdirSync(join(home, ".tps"), { recursive: true });
    writeFileSync(
      join(home, ".tps", "flair.json"),
      JSON.stringify({ hub: "https://flair.example", auth: null, localPort: 9926 }),
      "utf-8",
    );
    const result = await runJoin();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Flair spoke provisioning blocked");
  });

  test("an already-installed Flair spoke without --force-reinstall-flair exits 1", async () => {
    const authPath = join(home, "admin-pass");
    writeFileSync(authPath, "not-a-real-secret", "utf-8");
    mkdirSync(join(home, ".tps"), { recursive: true });
    writeFileSync(
      join(home, ".tps", "flair.json"),
      JSON.stringify({
        hub: "https://flair.example",
        auth: { mode: "admin-pass-file", path: authPath },
        localPort: 9926,
      }),
      "utf-8",
    );
    const result = await runJoin({ FAKE_FLAIR_PRESENT: "YES" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Flair is already installed");
  });

  test("a fed-sync configuration failure exits 1", async () => {
    const authPath = join(home, "auth-dir");
    mkdirSync(authPath, { recursive: true });
    mkdirSync(join(home, ".tps"), { recursive: true });
    writeFileSync(
      join(home, ".tps", "flair.json"),
      JSON.stringify({
        hub: "https://flair.example",
        // The hub auth path exists (so the plan is a spoke) but cannot be read
        // as a file, which is the configuration failure under test.
        auth: { mode: "admin-pass-file", path: authPath },
        localPort: 9926,
      }),
      "utf-8",
    );
    const result = await runJoin();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fed-sync configuration failed");
  });

  test("a Flair spoke provisioning failure exits 1", async () => {
    const authPath = join(home, "admin-pass");
    writeFileSync(authPath, "not-a-real-secret", "utf-8");
    mkdirSync(join(home, ".tps"), { recursive: true });
    writeFileSync(
      join(home, ".tps", "flair.json"),
      JSON.stringify({
        hub: "https://flair.example",
        auth: { mode: "admin-pass-file", path: authPath },
        localPort: 9926,
      }),
      "utf-8",
    );
    const result = await runJoin({ FAKE_UNAME_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Flair spoke provisioning failed");
  });
});
