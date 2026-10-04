import { expect, test } from "bun:test";
import { formatStampDiagnostic } from "../src/diagnostics.js";

for (const obligation of ["retained", "none", "unknown"] as const) {
  for (const retriesExhausted of [false, true]) {
    test(`${obligation}, exhausted=${retriesExhausted}`, () => {
      expect(formatStampDiagnostic({ kind: "stamp-failed", actor: "anvil", id: "inbound",
        path: "/mail/anvil/cur/inbound.json", code: "EACCES", obligation, retriesExhausted })).toBe(
        "tps-mail: stamp-failed: inbound actor=anvil path=/mail/anvil/cur/inbound.json code=EACCES; " +
        (obligation === "retained" ? "obligation retained; " : obligation === "unknown" ? "state unknown; " : "") +
        (retriesExhausted ? "no retries left; " : "") + "fix the path named above and restart the account");
    });
  }
}

test("optional id and retry flag", () => {
  expect(formatStampDiagnostic({ kind: "read-failed", actor: "anvil", path: "/mail/anvil/cur",
    code: "EACCES", obligation: "unknown" })).toBe("tps-mail: read-failed: actor=anvil path=/mail/anvil/cur code=EACCES; state unknown; fix the path named above and restart the account");
});
