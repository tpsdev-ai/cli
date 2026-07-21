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

  test("treats regex metacharacters in the prefix literally", () => {
    // With prefix "a.c" the leading-prefix strip must only fire on a literal
    // "a.c", never on "abc" (which it would if "." were treated as regex "any").
    expect(formatTaskCompleteMailBody("abc: shipped", "a.c")).toBe(
      "a.c:\n\nabc: shipped",
    );
    expect(formatTaskCompleteMailBody("a.c: shipped", "a.c")).toBe(
      "a.c:\n\nshipped",
    );
  });

  test("strips a metacharacter-bearing prefix used by a real caller", () => {
    // The "(via Flair)" caller carries parentheses; the strip must match them
    // literally and de-duplicate the leading prefix as intended.
    expect(
      formatTaskCompleteMailBody(
        "Task complete (via Flair): done",
        "Task complete (via Flair)",
      ),
    ).toBe("Task complete (via Flair):\n\ndone");
  });
});
