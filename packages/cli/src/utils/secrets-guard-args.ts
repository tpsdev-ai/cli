import { cliOptionTypes } from "./cli-flags.js";
import { parseCliArgs } from "./cli-args.js";

export const guardOptionTypes = cliOptionTypes;

export function parseGuardMode(argv: readonly string[]): { check: boolean; noGuard: boolean } {
  return parseCliArgs(argv).guardMode;
}
