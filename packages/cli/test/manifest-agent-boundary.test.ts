import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configuredAgentIds, keyringAgentIds, localAgentIds, readManifest, manifestPath, type CredentialsManifest } from "../src/utils/credentials-manifest.js";

describe("manifest agent boundary", () => {
  for (const agents of [null, "agent", {}, 42, [null], ["agent"], [{}], [{ id: 3 }], [{ id: "" }], [{ id: "../owner" }], [{ id: "a b" }], [{ id: "a".repeat(65) }], [{ id: "valid" }, { id: false }]]) {
    test(`invalid agents ${JSON.stringify(agents)} yield an empty list`, () => {
      const saved = existsSync(manifestPath()) ? readFileSync(manifestPath(), "utf8") : undefined;
      try {
        mkdirSync(dirname(manifestPath()), { recursive: true });
        const raw = { version: 1, credentials: {}, agents };
        writeFileSync(manifestPath(), JSON.stringify(raw));
        for (const m of [readManifest(), raw as unknown as CredentialsManifest]) {
          expect(configuredAgentIds(m)).toEqual([]);
          expect(keyringAgentIds(m)).toEqual([]);
          expect(localAgentIds(m)).toEqual([]);
        }
        expect(readManifest()?.agents).toEqual([]);
      } finally {
        if (saved === undefined) rmSync(manifestPath(), { force: true }); else writeFileSync(manifestPath(), saved);
      }
    });
  }
  for (const flag of ["false", "true", 0, 1, null, {}, []]) {
    test(`nonboolean flag ${JSON.stringify(flag)} is false at the read boundary`, () => {
      const saved = existsSync(manifestPath()) ? readFileSync(manifestPath(), "utf8") : undefined;
      try {
        mkdirSync(dirname(manifestPath()), { recursive: true });
        writeFileSync(manifestPath(), JSON.stringify({ version: 1, credentials: {}, agents: [{ id: "agent", local: flag, keyringPat: flag }] }));
        const m = readManifest();
        expect(m?.agents).toEqual([{ id: "agent", local: false, keyringPat: false }]);
        expect(configuredAgentIds(m)).toEqual(["agent"]);
        expect(localAgentIds(m)).toEqual([]);
        expect(keyringAgentIds(m)).toEqual([]);
      } finally {
        if (saved === undefined) rmSync(manifestPath(), { force: true }); else writeFileSync(manifestPath(), saved);
      }
    });
  }
  test("only true enables flags", () => {
    const m: CredentialsManifest = { version: 1, credentials: {}, agents: [{ id: "enabled", local: true, keyringPat: true }, { id: "disabled", local: false, keyringPat: false }] };
    expect(localAgentIds(m)).toEqual(["enabled"]);
    expect(keyringAgentIds(m)).toEqual(["enabled"]);
  });
});
