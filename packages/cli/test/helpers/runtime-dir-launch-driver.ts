import { mock } from "bun:test";
import { resolve } from "node:path";

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
await runAgent({ action: "start", id: "probe", runtime: "claude-code", sandboxRequired: true });
