import { mock } from "bun:test";
import { resolve } from "node:path";

const attestationPath = resolve(import.meta.dir, "../../src/utils/launch-attestation.ts");
const attestation = await import(attestationPath);
mock.module(attestationPath, () => ({
  ...attestation,
  resolveNonoBinary: () => ({ bin: "/fixture/nono" }),
  launchAttested: async (profile: string, options: unknown, cmd: string[]) => {
    console.log("HANDOFF " + JSON.stringify({ profile, options, cmd, cwd: process.cwd() }));
    return 0;
  },
}));

const { runAgent } = await import("../../src/commands/agent.js");
await runAgent({ action: "start", id: "probe", runtime: "claude-code", sandboxRequired: true });
