import { cliOptionConsumesValue, cliOptionTypes } from "./cli-flags.js";

export const guardOptionTypes = cliOptionTypes;

export function parseGuardMode(argv: readonly string[]): { check: boolean; noGuard: boolean } {
  let check = false;
  let noGuard = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--" || !arg.startsWith("-")) break;
    if (arg === "--check") check = true;
    else if (arg === "--no-guard") noGuard = true;
    else if (/^--(?:check|no-check|no-guard|no-no-guard|guard|noGuard|no-noGuard|noCheck)(?:=|$)/.test(arg)) {
      throw new Error(`InvalidSecretsGuardMode: ${arg}; use bare --check or --no-guard`);
    }
    if (check && noGuard) {
      throw new Error("InvalidSecretsGuardMode: --check and --no-guard conflict");
    }
    const type = guardOptionTypes.get(arg);
    if (cliOptionConsumesValue(arg, argv[i + 1])) {
      i++;
    } else if (type === "boolean" && (argv[i + 1] === "true" || argv[i + 1] === "false")) {
      if (arg === "--check" || arg === "--no-guard") {
        throw new Error(`InvalidSecretsGuardMode: ${arg} ${argv[i + 1]}; use bare --check or --no-guard`);
      }
      i++;
    }
  }
  return { check, noGuard };
}
