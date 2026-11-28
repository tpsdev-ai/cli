// The npm guard's refusal text (cli#948 design v2 item 7): fixed wording, the
// redacted command, and arguments sanitized byte by byte.

export const SUPPORTED_INSTALL_PATH = "scripts/npm-ci-tracked-lock.sh";

// Blank `--otp`/`--password` values in both spellings and any `_authToken`
// value, then collapse `scheme://userinfo@host` to `scheme://host`.
export function redactArgs(argv) {
  const redacted = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const assigned = /^--(otp|password)=(.*)$/.exec(arg);
    if (assigned) {
      redacted.push(`--${assigned[1]}=[REDACTED]`);
      continue;
    }
    if (arg === "--otp" || arg === "--password") {
      redacted.push(arg);
      if (i + 1 < argv.length) {
        redacted.push("[REDACTED]");
        i += 1;
      }
      continue;
    }
    redacted.push(
      arg
        .replace(/(_authToken=)[^\s]*/gi, "$1[REDACTED]")
        .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/g, "$1"),
    );
  }
  return redacted;
}

// Printable ASCII only: every C0 byte, every C1 byte and the high bytes of a
// multi-byte character are dropped. `::` at the start of a line would be a
// workflow command, so it is neutralized.
export function sanitizeText(value) {
  const bytes = Buffer.from(String(value), "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
  }
  return out.replace(/^::/gm, ": :");
}

export function formatRefusal({ tool, argv, job, action, reason }) {
  const command = [tool ?? "npm", ...redactArgs(argv ?? [])].map(sanitizeText).join(" ");
  const lines = [
    "npm-guard: command refused",
    "",
    `  GITHUB_JOB: ${sanitizeText(job || "(unset)")}`,
    `  GITHUB_ACTION: ${sanitizeText(action || "(unset)")}`,
    `  command: ${command}`,
    `  reason: ${sanitizeText(reason || "(unset)")}`,
    "",
    "  installation not started: the real npm was not invoked.",
    `  Supported path for installs: ${SUPPORTED_INSTALL_PATH}`,
    "",
  ];
  return lines.join("\n");
}
