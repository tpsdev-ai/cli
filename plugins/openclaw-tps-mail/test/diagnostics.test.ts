import { expect, test } from "bun:test";
import { formatStampDiagnostic } from "../src/diagnostics.js";

for (const obligation of ["retained", "none", "unknown"] as const) {
  for (const retriesExhausted of [false, true]) {
    test(`${obligation}, exhausted=${retriesExhausted}`, () => {
      expect(formatStampDiagnostic({ kind: "ack-stamp-failed", actor: "anvil", id: "inbound",
        path: "/mail/anvil/cur/inbound.json", code: "EACCES", obligation, retriesExhausted })).toBe(
        "tps-mail: ack-stamp-failed: inbound actor=anvil path=/mail/anvil/cur/inbound.json code=EACCES; " +
        (obligation === "retained" ? "obligation retained; " : obligation === "unknown" ? "state unknown; " : "") +
        (retriesExhausted ? "no retries left; " : "") + "resolve the failure and restart the account");
    });
  }
}

test("optional id and retry flag", () => {
  expect(formatStampDiagnostic({ kind: "stamp-reconcile-read-failed", actor: "anvil", path: "/mail/anvil/cur/inbound.json",
    code: "EACCES", obligation: "unknown" })).toBe("tps-mail: stamp-reconcile-read-failed: actor=anvil path=/mail/anvil/cur/inbound.json code=EACCES; state unknown; resolve the failure and restart the account");
});

test("an uncoded stamp failure omits code", () => {
  const message = formatStampDiagnostic({ kind: "ack-stamp-failed", actor: "anvil",
    path: "/mail/anvil/cur/inbound.json", obligation: "unknown" });
  expect(message).not.toContain("code=");
  expect(message).toContain("state unknown");
});
