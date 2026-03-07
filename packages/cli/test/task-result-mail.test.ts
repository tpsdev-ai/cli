import { describe, expect, test } from "bun:test";
import { formatTaskCompleteMailBody } from "../src/utils/task-result-mail.ts";

describe("formatTaskCompleteMailBody", () => {
  test("strips a duplicate task-complete prefix on the same line", () => {
    expect(formatTaskCompleteMailBody("Task complete: shipped the fix")).toBe(
      "Task complete:\n\nshipped the fix",
    );
  });

  test("strips a duplicate task-complete prefix followed by a newline", () => {
    expect(formatTaskCompleteMailBody("Task complete:\nshipped the fix")).toBe(
      "Task complete:\n\nshipped the fix",
    );
  });

  test("keeps summaries that do not start with the prefix", () => {
    expect(formatTaskCompleteMailBody("Shipped the fix")).toBe(
      "Task complete:\n\nShipped the fix",
    );
  });
});
