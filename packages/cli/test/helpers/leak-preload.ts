/**
 * leak-preload.ts — cli#568: the one preload bun runs for the cli test lane
 * (listed in packages/cli/bunfig.toml). It appends both per-file leak checks to
 * each `.test`/`.spec` file: the process.env check (cli#555,
 * helpers/env-leak-preload.ts) and the guarded-global check (cli#568,
 * helpers/global-leak-preload.ts).
 *
 * One plugin, two checks: measured on bun 1.3.10, when two preloads register a
 * plugin with the same onLoad filter, only the first one's onLoad runs, so the
 * checks cannot each own a plugin.
 */
import { plugin } from "bun";
import { envGuardOnLoad, envGuardSnippet, installEnvGuard } from "./env-leak-preload.js";
import { globalGuardOnLoad, globalGuardSnippet, installGlobalLeakGuard } from "./global-leak-preload.js";

const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

installEnvGuard();
installGlobalLeakGuard();

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith("tsx")) return "tsx";
  if (path.endsWith("jsx")) return "jsx";
  return /ts$/.test(path) ? "ts" : "js";
}

plugin({
  name: "cli-test-leak-guard",
  setup(build) {
    build.onLoad({ filter: TEST_FILE }, async ({ path }) => {
      envGuardOnLoad(path);
      globalGuardOnLoad(path);
      const source = await Bun.file(path).text();
      return { contents: `${source}\n;${envGuardSnippet(path)}${globalGuardSnippet(path)}\n`, loader: loaderFor(path) };
    });
  },
});
