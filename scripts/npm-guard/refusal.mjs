// The npm guard's refusal text (cli#948 design v2 item 7): fixed wording, the
// redacted command, and arguments sanitized byte by byte.

export const SUPPORTED_INSTALL_PATH = "scripts/npm-ci-tracked-lock.sh";

// Drop everything up to the last `@` of every URL authority in an argument
// (whitespace and control bytes included), then blank the whole value of
// `--otp`/`--password` in both spellings and everything after `_authToken`.
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
    let cleaned = arg.replace(
      /([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:(?![A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#])*/g,
      (match, scheme) => {
        const at = match.lastIndexOf("@");
        return at === -1 ? match : scheme + match.slice(at + 1);
      },
    );
    const tokenAt = cleaned.indexOf("_authToken");
    if (tokenAt !== -1) {
      const tokenEnd = tokenAt + "_authToken".length;
      const kept = cleaned[tokenEnd] === "=" ? tokenEnd + 1 : tokenEnd;
      cleaned = `${cleaned.slice(0, kept)}[REDACTED]`;
    }
    redacted.push(cleaned);
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
