/**
 * mail-routing.ts — ONE locality decision for outbound mail (cli#389).
 *
 * Two writers disagreed about where a reply belongs. `tps mail send`
 * (commands/mail.ts) routes by host type and the GAL; the openclaw-tps-mail
 * plugin had a SECOND rule — "a directory named after the recipient exists" —
 * that silently reclassified a REMOTE peer as local whenever a maildir had been
 * created for archiving, inspection, or by accident, so the reply was written
 * where nothing would ever read it.
 *
 * This module is the single decision both import:
 *   - a BRANCH host (it carries `~/.tps/identity/host.json`) relays cross-host
 *     mail through `~/.tps/outbox/new/`; only a recipient bound to THIS gateway
 *     stays local. Directory existence never matters on a branch.
 *   - the OFFICE host sends a recipient whose branch is registered for remote
 *     delivery (`~/.tps/branch-office/<branch>/remote.json`) over the wire, and
 *     treats everything else as local.
 *
 * `unknown` is a NAMED failure for the plugin (never a silent write); the CLI
 * keeps its own fallback for that case.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { galLookup } from "./gal.js";

/** The TPS home root: an explicit HOME, then the process HOME, then os.homedir(). */
export function tpsHome(home?: string): string {
  return home || process.env.HOME || homedir();
}

/** True when this host is a BRANCH: it carries a host identity file. */
export function isBranchHost(home?: string): boolean {
  return existsSync(join(tpsHome(home), ".tps", "identity", "host.json"));
}

/**
 * The physical branch id a recipient resolves to: its GAL entry, else the
 * recipient name itself. Mirrors `tps mail send` — an unsynced GAL must not turn
 * a registered remote branch into a local write.
 */
export function effectiveBranchId(to: string): string {
  return galLookup(to) ?? to;
}

/**
 * The branch a recipient is registered to for REMOTE delivery, or null. Requires
 * a `remote.json` for the recipient's branch — the presence of the branch
 * office directory ALONE is not enough.
 */
export function remoteBranchFor(to: string, home?: string): string | null {
  const branchId = effectiveBranchId(to);
  return existsSync(join(tpsHome(home), ".tps", "branch-office", branchId, "remote.json")) ? branchId : null;
}

export type MailRoute =
  | { kind: "local"; mailDir: string }
  | { kind: "outbox" }
  | { kind: "remote-branch"; branchId: string }
  | { kind: "unknown"; mailDir: string };

export interface MailLocality {
  /** The recipient. */
  to: string;
  /** The local maildir root (CLI: ~/.tps/mail; plugin: the account's mailDir). */
  mailDir: string;
  /** Agents bound to the calling gateway. The CLI has none: omit it. */
  localAgents?: readonly string[];
  /** Test/embedding override for the TPS home root. */
  home?: string;
}

/**
 * ONE locality decision, shared by `tps mail send` and the openclaw-tps-mail
 * plugin (both its dispatcher reply path and its outbound adapter).
 */
export function resolveMailRoute(input: MailLocality): MailRoute {
  const { to, mailDir } = input;
  const localAgents = input.localAgents ?? [];

  // (1) BRANCH: bound recipients are local; everything else is relayed.
  if (isBranchHost(input.home)) {
    return localAgents.includes(to) ? { kind: "local", mailDir } : { kind: "outbox" };
  }

  // (2) OFFICE: a registered remote branch goes over the wire; everything else
  // is delivered into a local maildir.
  const branchId = remoteBranchFor(to, input.home);
  if (branchId) return { kind: "remote-branch", branchId };
  if (localAgents.includes(to) || existsSync(join(mailDir, to))) return { kind: "local", mailDir };

  // (3) OFFICE, unknown recipient: no GAL, no binding, no maildir. A named
  // failure — never a silent write into a directory nothing reads.
  return { kind: "unknown", mailDir };
}
