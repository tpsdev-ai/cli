import { describe, expect, it } from "bun:test";
import { skillNameFromCli } from "../src/commands/skill.js";

describe("skill name from the command line (cli#360)", () => {
  it("show takes the name from the first positional", () => {
    expect(skillNameFromCli("show", ["show", "my-skill"], undefined)).toBe("my-skill");
   });
  it("revoke takes the name from the first positional", () => {
    expect(skillNameFromCli("revoke", ["revoke", "my-skill"], undefined)).toBe("my-skill");
   });
  it("--name wins over the positional", () => {
    expect(skillNameFromCli("show", ["show", "positional"], "flagged")).toBe("flagged");
   });
  it("other actions do not read a positional name", () => {
    expect(skillNameFromCli("scan", ["scan", "file.md"], undefined)).toBeUndefined();
   });
});
