#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withScratchFlair, type ScratchFlair } from "../packages/cli/test/helpers/scratch-flair.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = join(REPO, "packages", "cli");

export const EXPECTED_CASES: Record<string, string[]> = {
  "real-flair.test.ts": [
    "a signed memory write reads back with the fields it was written with",
    "a non-admin searching another agent's scope is refused, and its own scope is served",
    "archiving over PATCH keeps the memory's other fields",
    "agent registration reads its key back from Flair, the cli#512 seam",
  ],
  "agent-create-registration.test.ts": [
    "against a real Flair, create refuses when the generated key cannot be registered",
    "against a real Flair, create succeeds with an existing Agent and matching local key",
    "against a real Flair, create on a pending row completes registration when the instance serves POST /AgentKeyRegister, and refuses otherwise",
  ],
  "mail-flair-read-auth.test.ts": ["real Flair Agent read guards and refused-read mail recovery"],
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity];
  });
}

export function assertRealFlairReport(xml: string): void {
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], decodeXml(attr[2])]));
    return { name: attrs.name, file: attrs.file, body: match[2] ?? "" };
  });
  for (const [file, names] of Object.entries(EXPECTED_CASES)) {
    for (const name of names) {
      const found = cases.filter((item) => item.name === name && item.file?.replaceAll("\\", "/").endsWith(`/${file}`));
      if (found.length !== 1 || /<(?:skipped|failure|error)\b/.test(found[0].body)) {
        throw new Error(`real-flair lane: expected a passed, unskipped case: ${file}: ${name}`);
      }
    }
  }
}

export async function runRealFlairSuite(
  flair: Pick<ScratchFlair, "httpPort" | "opsPort">,
  signal: AbortSignal,
  files = Object.keys(EXPECTED_CASES).map((file) => `test/${file}`),
): Promise<number> {
  const reportDir = process.env.TPS_TEST_REPORT_DIR
    ? resolve(CLI_DIR, process.env.TPS_TEST_REPORT_DIR)
    : join(REPO, "test-reports");
  const child = spawn("node", [join(REPO, "scripts", "test-suite.mjs"), "real-flair", ...files], {
    cwd: CLI_DIR,
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      TPS_TEST_REPORT_DIR: reportDir,
      TPS_TEST_REAL_FLAIR: "1",
      TPS_TEST_FLAIR_HTTP_PORT: String(flair.httpPort),
      TPS_TEST_FLAIR_OPS_PORT: String(flair.opsPort),
    },
  });
  const terminate = () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* child already exited */ }
    }
  };
  signal.addEventListener("abort", terminate, { once: true });
  let code: number;
  try {
    code = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (status) => resolveExit(status ?? 1));
    });
  } finally {
    signal.removeEventListener("abort", terminate);
  }
  assertRealFlairReport(readFileSync(join(reportDir, "real-flair.xml"), "utf8"));
  return code;
}

async function main(): Promise<void> {
  const files = Object.keys(EXPECTED_CASES).map((file) => `test/${file}`);
  console.log(`real-flair lane: ${files.length} named file(s): ${files.join(", ")}`);
  process.exitCode = await withScratchFlair((flair, signal) => runRealFlairSuite(flair, signal, files));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
