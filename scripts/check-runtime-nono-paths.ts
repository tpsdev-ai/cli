import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildNonoArgs, harnessReadPaths, runtimeNonoOptions, runtimeNonoProfile } from "../packages/cli/src/utils/nono.ts";

const bin = process.env.NONO_BIN;
if (!bin) throw new Error("NONO_BIN must name the real pinned nono");
const root = mkdtempSync(join(tmpdir(), "runtime-nono-"));
const home = join(root, "home");
const ws = join(root, "ws");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), CODEX_HOME: join(home, "codex-custom"), CLAUDE_CONFIG_DIR: join(home, "claude-custom"), XDG_STATE_HOME: join(root, "state"), NONO_NO_UPDATE_CHECK: "1" };
const paths = {
  "claude-code": [".claude/.credentials.json", "claude-custom/.credentials.json", ".claude.json", ".claude.lock", ".claude/projects/session", "claude-custom/projects/session"],
  codex: ["codex-custom/auth.json", "codex-custom/sessions/session", ".config/codex/auth.json", ".config/codex/sessions/session", ".tps/auth/openai.json"],
  gemini: [".gemini/oauth_creds.json", ".gemini/tmp/session", ".config/gemini/oauth_creds.json", ".config/gemini/tmp/session"],
};
const defaults = { ...env };
delete defaults.CODEX_HOME;
delete defaults.CLAUDE_CONFIG_DIR;
const cases = [
  { runtime: "claude-code", names: paths["claude-code"], env },
  { runtime: "codex", names: paths.codex, env },
  { runtime: "codex", names: [".codex/auth.json", ".codex/sessions/session", ".config/codex/auth.json", ".config/codex/sessions/session", ".tps/auth/openai.json"], env: defaults },
  { runtime: "gemini", names: paths.gemini, env },
  { runtime: "gemini", names: [".gemini/oauth_creds.json", ".gemini/tmp/session", "xdg-custom/gemini/oauth_creds.json", "xdg-custom/gemini/tmp/session"], env: { ...env, XDG_CONFIG_HOME: join(home, "xdg-custom") } },
];
const credentials = [".aws/credentials", ".tps/auth/openai.json", ".tps/auth/anthropic.json", ".tps/auth/google.json", ".tps/secrets/token", ".claude/.credentials.json", "codex-custom/auth.json", ".codex/auth.json", ".gemini/oauth_creds.json"];
try {
  mkdirSync(ws, { recursive: true });
  for (const name of new Set([...cases.flatMap((c) => c.names), ...credentials])) {
    const path = join(home, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture-secret");
  }
  for (const {runtime, names, env: caseEnv} of cases) {
    const grants = runtimeNonoOptions(runtime, caseEnv);
    const profile = runtimeNonoProfile(runtime);
    const deniedPaths = credentials.filter((p) => !names.includes(p));
    const argv = buildNonoArgs(profile, { ...grants, workdir: ws, read: harnessReadPaths() }, [
      "sh", "-c", 'n="$1"; shift; while [ "$n" -gt 0 ]; do [ "$(cat "$1")" = fixture-secret ] || exit 1; printf fixture-secret > "$1" || exit 1; shift; n=$((n-1)); done; for p do if out=$(cat "$p" 2>/dev/null); then exit 2; fi; [ -z "$out" ] || exit 3; done',
      "probe", String(names.length), ...names.map((p) => join(home, p)), ...deniedPaths.map((p) => join(home, p)),
    ], caseEnv);
    const result = spawnSync(bin, argv, { env: caseEnv, cwd: ws, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) throw new Error(`${runtime}: credential/state and denial probe failed: ${result.stderr}`);
    console.log(`${runtime}: credential/state reads and writes allowed; unrelated credentials denied`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
