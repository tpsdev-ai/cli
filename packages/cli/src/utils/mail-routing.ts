/**
 * mail-routing.ts — ONE locality decision for outbound mail (cli#389).
 *
 * Two writers disagreed about where a reply belongs. `tps mail send`
 * (commands/mail.ts) routed by host type and the GAL; the openclaw-tps-mail
 * plugin had a SECOND rule — "a directory named after the recipient exists" —
 * that silently reclassified a REMOTE peer as local whenever a maildir had been
 * created for archiving, inspection, or by accident, so the reply was written
 * where nothing would ever read it.
 *
 * This module is the single decision both `tps mail send` and the plugin
 * (its dispatcher reply path and its outbound adapter) import:
 *
 *   - BRANCH (`~/.tps/identity/host.json` present): a recipient BOUND to this
 *     gateway is local; every other recipient is relayed through
 *     `~/.tps/outbox/new/`. Directory existence never matters on a branch.
 *   - OFFICE, GAL entry whose branch has `remote.json` → `remote-branch`.
 *   - OFFICE, GAL entry whose branch has NO `remote.json` → `failed`
 *     (`gal-without-remote`): a misconfiguration, refused whatever maildirs
 *     exist, never a fall-through to a local write.
 *   - OFFICE, NO GAL entry:
 *       - `remote.json` under the RECIPIENT'S OWN NAME → `remote-branch`. A
 *         branch addressed by its own id is what `tps mail send` has always
 *         done, so it is kept.
 *       - `~/.tps/branch-office/<to>/mail/inbox` (no `remote.json`) → `bridge`
 *         (a local branch-office sandbox, delivered with `deliverToSandbox`).
 *       - a binding or a local maildir → `local`.
 *       - otherwise → `unknown`, a NAMED failure: never a silent write.
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

export type MailRoute =
  | { kind: "local"; mailDir: string }
  | { kind: "outbox" }
  | { kind: "remote-branch"; branchId: string }
  | { kind: "bridge"; branchId: string }
  | { kind: "failed"; reason: "gal-without-remote"; branchId: string }
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
 * The ONE locality decision, shared by `tps mail send` and the openclaw-tps-mail
 * plugin. See the module header for the full table.
 */
export function resolveMailRoute(input: MailLocality): MailRoute {
  const { to, mailDir } = input;
  const localAgents = input.localAgents ?? [];
  const branchOffice = (...parts: string[]) => join(tpsHome(input.home), ".tps", "branch-office", ...parts);

  // (1) BRANCH: bound recipients are local; everything else is relayed.
  if (isBranchHost(input.home)) {
    return localAgents.includes(to) ? { kind: "local", mailDir } : { kind: "outbox" };
  }

  // (2) OFFICE, GAL entry: remote when its branch is registered, else a NAMED
  // misconfiguration — never a fall-through to a local write.
  const galBranchId = galLookup(to);
  if (galBranchId) {
    if (existsSync(branchOffice(galBranchId, "remote.json"))) {
      return { kind: "remote-branch", branchId: galBranchId };
    }
    return { kind: "failed", reason: "gal-without-remote", branchId: galBranchId };
  }

  // (3) OFFICE, no GAL entry: a recipient addressed by its OWN branch id
  // (remote.json under the recipient name) is still remote — what `tps mail
  // send` has always done.
  if (existsSync(branchOffice(to, "remote.json"))) {
    return { kind: "remote-branch", branchId: to };
  }

  // (4) OFFICE, a local branch-office sandbox inbox (no remote.json): bridge.
  if (existsSync(branchOffice(to, "mail", "inbox"))) {
    return { kind: "bridge", branchId: to };
  }

  // (5) OFFICE, otherwise: a binding or an existing maildir is local.
  if (localAgents.includes(to) || existsSync(join(mailDir, to))) return { kind: "local", mailDir };

  // (6) OFFICE, unknown recipient: no GAL, no binding, no maildir.
  return { kind: "unknown", mailDir };
}
