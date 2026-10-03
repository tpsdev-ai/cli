import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const bin = resolve(import.meta.dir, "../dist/bin/tps.js");
describe("CLI identity boundary", () => {
  for (const [route, label] of [[['tui'], 'TUI agent id'], [['ui'], 'TUI agent id'], [['office', 'health', '--once'], 'office health viewer id']] as const) {
    test(`${route.join(" ")} refuses with no id`, () => {
      const home = mkdtempSync(join(tmpdir(), "entry-identity-"));
      try {
        const env = { ...process.env, HOME: home };
        delete env.TPS_AGENT_ID;
        const result = spawnSync(process.execPath.endsWith("bun") ? "bun" : "node", [bin, ...route], { env, encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`no ${label}`);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  }
  for (const route of [['tui'], ['office', 'health', '--once']]) {
    for (const flags of [[], ['--agent', 'explicit-agent'], ['--id', 'explicit-id']]) {
      test(`${route.join(" ")} resolves ${flags.join(" ") || "TPS_AGENT_ID"}`, () => {
        const home = mkdtempSync(join(tmpdir(), "entry-configured-"));
        try {
          const loader = join(home, "loader.mjs");
          const register = join(home, "register.mjs");
          const handler = join(home, "handler.mjs");
          writeFileSync(register, 'import { register } from "node:module"; register(new URL("./loader.mjs", import.meta.url));');
          writeFileSync(loader, `export async function resolve(specifier, context, next) {
            if (context.parentURL?.endsWith("/dist/bin/tps.js") && ["../src/commands/tui.js", "../src/commands/office-health.js", "ink"].includes(specifier))
              return { url: new URL("./handler.mjs", import.meta.url).href, shortCircuit: true };
            return next(specifier, context);
          }`);
          writeFileSync(handler, 'export function TuiApp() {}\nexport function render(element) { console.log(element.props.agentId); }\nexport async function runOfficeHealth(args) { console.log(args.viewerId); }');
          const result = spawnSync("node", ["--import", register, bin, ...route, ...flags], {
            env: { ...process.env, HOME: home, TPS_AGENT_ID: "configured-agent" }, encoding: "utf8", timeout: 10_000,
          });
          expect(result.status).toBe(0);
          expect(result.stdout.trim()).toBe(flags[1] ?? "configured-agent");
        } finally { rmSync(home, { recursive: true, force: true }); }
      });
    }
  }
});
