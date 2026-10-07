import { mock } from "bun:test";
import { join, resolve, sep } from "node:path";
import * as fs from "node:fs";

const insensitiveRoot = process.env.TPS_TEST_CASE_INSENSITIVE_ROOT;
if (insensitiveRoot) {
  const originalFs = { ...fs };
  const insensitive = (method: typeof fs.statSync | typeof fs.lstatSync) => (path: fs.PathLike, ...args: unknown[]) => {
    if (typeof path === "string" && (path.toLowerCase() === insensitiveRoot.toLowerCase() ||
      path.toLowerCase().startsWith(`${insensitiveRoot.toLowerCase()}${sep}`))) {
      const parts = path.slice(insensitiveRoot.length).split(sep).filter(Boolean);
      let actual = insensitiveRoot;
      for (const part of parts) {
        const entry = originalFs.readdirSync(actual).find((name) => name.toLowerCase() === part.toLowerCase());
        actual = join(actual, entry ?? part);
      }
      return Reflect.apply(method, originalFs, [actual, ...args]);
    }
    return Reflect.apply(method, originalFs, [path, ...args]);
  };
  mock.module("node:fs", () => ({
    ...originalFs,
    statSync: insensitive(originalFs.statSync),
    lstatSync: insensitive(originalFs.lstatSync),
  }));
}

const attestationPath = resolve(import.meta.dir, "../../src/utils/launch-attestation.ts");
const attestation = await import(attestationPath);
mock.module(attestationPath, () => ({
  ...attestation,
  resolveNonoBinary: () => ({ bin: "/fixture/nono" }),
  launchAttested: async (profile: string, options: import("../../src/utils/nono.js").NonoOptions, cmd: string[], opts: unknown) => {
    const { buildNonoArgs } = await import("../../src/utils/nono.js");
    console.log("HANDOFF " + JSON.stringify({ profile, options, cmd, opts, args: buildNonoArgs(profile, options, cmd), cwd: process.cwd() }));
    return 0;
  },
}));

const { runAgent } = await import("../../src/commands/agent.js");
await runAgent({ action: "start", id: "probe", runtime: process.env.TPS_TEST_DEFAULT_RUNTIME ? undefined : "claude-code", sandboxRequired: true });
