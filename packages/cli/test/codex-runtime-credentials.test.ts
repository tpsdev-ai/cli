import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerAuthPath } from "../src/utils/runtime-credentials.js";

test("Codex runtime reads OpenAI credentials saved by auth login", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-runtime-creds-"));
  try {
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    const credentials = {
      accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 60_000, clientId: "fixture-client",
    };
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(credentials));
    const env = { ...process.env, HOME: root, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(root, "xdg") };
    const child = spawnSync(process.execPath, ["--eval", `
      import { runAuth } from ${JSON.stringify(join(import.meta.dir, "../src/commands/auth.ts"))};
      import { runCodexRuntime } from ${JSON.stringify(join(import.meta.dir, "../src/utils/codex-runtime.ts"))};
      import { unlinkSync } from "node:fs";
      await runAuth({ action: "login", provider: "openai" });
      unlinkSync(${JSON.stringify(join(codexHome, "auth.json"))});
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://auth.openai.com/oauth/token") {
          console.log("REFRESH " + JSON.stringify(Object.fromEntries(new URLSearchParams(init.body))));
          process.exit(0);
        }
        throw new Error("Unexpected request: " + url);
      };
      setTimeout(() => process.exit(2), 1000);
      await runCodexRuntime({ agentId: "fixture", workspace: process.env.HOME, mailDir: process.env.HOME });
    `], { env, cwd: root, encoding: "utf8", timeout: 5000 });
    const output = `${child.stdout}${child.stderr}`;
    expect(JSON.parse(readFileSync(providerAuthPath("openai", env), "utf8"))).toMatchObject(credentials);
    const refresh = child.stdout.split("\n").find((line) => line.startsWith("REFRESH "));
    expect(refresh, output).toBeDefined();
    expect(JSON.parse(refresh!.slice("REFRESH ".length))).toEqual({
      grant_type: "refresh_token", client_id: "fixture-client", refresh_token: "fixture-refresh",
    });
    expect(child.status, output).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
