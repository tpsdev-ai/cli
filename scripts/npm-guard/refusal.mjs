// The npm guard's refusal text (cli#948 design v2 item 7): fixed wording, the
// redacted command, and arguments sanitized byte by byte.

export const SUPPORTED_INSTALL_PATH = "scripts/npm-ci-tracked-lock.sh";

// Blank the whole value of `--otp`/`--password` in both spellings and of any
// argument containing `_authToken` before sanitizing, then collapse
// `scheme://userinfo@host` to `scheme://host`.
export function redactArgs(argv) {
  const redacted = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg.startsWith("--otp=") || arg.startsWith("--password=")) {
      redacted.push(`${arg.slice(0, arg.indexOf("=") + 1)}[REDACTED]`);
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
    const tokenAt = arg.indexOf("_authToken");
    if (tokenAt !== -1) {
      const equalsAt = arg.indexOf("=", tokenAt);
      const kept = equalsAt === -1 ? tokenAt + "_authToken".length : equalsAt + 1;
      redacted.push(`${arg.slice(0, kept)}[REDACTED]`);
      continue;
    }
    redacted.push(arg.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/g, "$1"));
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
