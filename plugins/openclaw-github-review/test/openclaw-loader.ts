/**
 * openclaw-loader.ts (test helper) — drives the BUILT plugin through OpenClaw's
 * REAL plugin registration machinery, using the openclaw install already in the
 * plugin's lockfile.
 *
 * OpenClaw's plugin registry loader (`loadOpenClawPlugins`) requires a complete
 * gateway config and is not reachable through the package's `exports` map, but
 * the two pieces it uses to register a plugin ARE reachable as module files: the
 * api builder (`buildPluginApi`) and the registration runner
 * (`testing.runPluginRegisterSync`). This helper imports those real modules by
 * absolute path and runs the plugin's own `register` through them — the SAME
 * code path the gateway uses, with `registrationMode: "full"`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface CapturedTool {
  name: string;
  factory: (ctx: Record<string, unknown>) => unknown;
}

export interface RegisterOptions {
  /** Directory containing the plugin package (for the built entry). */
  pluginDir: string;
  /** The openclaw install's dist directory. */
  openclawDistDir: string;
  pluginConfig: unknown;
  registrationMode?: string;
  pluginVersion?: string;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

function findChunk(distDir: string, names: RegExp, marker: string): string {
  for (const f of readdirSync(distDir)) {
    if (!names.test(f)) continue;
    try {
      if (readFileSync(join(distDir, f), "utf8").includes(marker)) return join(distDir, f);
    } catch {
      /* skip unreadable */
    }
  }
  throw new Error(`no openclaw chunk in ${distDir} matching ${names} containing "${marker}"`);
}

/** Register the built plugin through OpenClaw's real api builder + registration
 *  runner, returning the tools it registered. */
export async function registerBuiltPlugin(opts: RegisterOptions): Promise<{ tools: CapturedTool[]; logs: string[] }> {
  const dist = opts.openclawDistDir;
  const apiBuilderPath = findChunk(dist, /^api-builder-.*\.js$/, "function buildPluginApi");
  const loaderPath = findChunk(dist, /^loader-.*\.js$/, "loadOpenClawPlugins");

  const apiBuilder = (await import(pathToFileURL(apiBuilderPath).href)) as Record<string, unknown>;
  const loader = (await import(pathToFileURL(loaderPath).href)) as Record<string, unknown>;

  // The chunks are minified, so resolve the real export names from the module
  // text rather than guessing at the aliases.
  const apiBuilderSrc = readFileSync(apiBuilderPath, "utf8");
  const loaderSrc = readFileSync(loaderPath, "utf8");
  const buildName = /buildPluginApi as ([A-Za-z0-9_$]+)/.exec(apiBuilderSrc)?.[1];
  const testingName = /testing as ([A-Za-z0-9_$]+)/.exec(loaderSrc)?.[1];
  if (!buildName || typeof apiBuilder[buildName] !== "function") {
    throw new Error("could not resolve buildPluginApi in the openclaw api-builder chunk");
  }
  if (!testingName || !(loader[testingName] as { runPluginRegisterSync?: unknown } | undefined)?.runPluginRegisterSync) {
    throw new Error("could not resolve the plugin registration runner in the openclaw loader chunk");
  }
  const buildPluginApi = apiBuilder[buildName] as (p: unknown) => unknown;
  const { runPluginRegisterSync } = loader[testingName] as {
    runPluginRegisterSync: (register: (api: unknown) => void, api: unknown) => void;
  };

  const logs: string[] = [];
  const logger =
    opts.logger ??
    {
      info: (...a: unknown[]) => logs.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.push(a.join(" ")),
      error: (...a: unknown[]) => logs.push(a.join(" ")),
    };

  const tools: CapturedTool[] = [];
  const api = buildPluginApi({
    id: "openclaw-github-review",
    name: "GitHub Review",
    version: opts.pluginVersion ?? "0.1.0-test",
    source: opts.pluginDir,
    rootDir: opts.pluginDir,
    registrationMode: opts.registrationMode ?? "full",
    config: {},
    pluginConfig: opts.pluginConfig,
    logger,
    handlers: {
      registerTool: (tool: unknown, toolOpts?: { name?: string }) => {
        const factory =
          typeof tool === "function" ? (tool as CapturedTool["factory"]) : () => tool;
        tools.push({ name: toolOpts?.name ?? "(unnamed)", factory });
      },
    },
  });

  const entry = resolve(opts.pluginDir, "dist", "src", "index.js");
  const mod = (await import(pathToFileURL(entry).href)) as { default: { register: (api: unknown) => void } };
  runPluginRegisterSync(mod.default.register, api);
  return { tools, logs };
}

/** Locate the openclaw install's dist dir from the plugin's node_modules. */
export function openclawDistDir(pluginDir: string): string {
  return join(pluginDir, "node_modules", "openclaw", "dist");
}
