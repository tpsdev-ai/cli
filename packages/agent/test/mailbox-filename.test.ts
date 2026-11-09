import { expect, test } from "bun:test";
import { isMailboxMessageFile } from "../src/lib/mailbox-filename.js";

for (const [name, expected] of [
  [".x.json", false],
  ["message.txt", false],
  ["2026-11-08-message.json", true],
  ["", false],
  ["nested/message.json", false],
  ["nested\\message.json", false],
  ["message.JSON", false],
] as const) {
  test(`mailbox filename ${JSON.stringify(name)} is ${expected}`, () => {
    expect(isMailboxMessageFile(name)).toBe(expected);
  });
}
