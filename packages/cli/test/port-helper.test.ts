import { describe, expect, test } from "bun:test";
import { isAddressInUse, PORT_ATTEMPTS, withPortRetry } from "./helpers/port.js";

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("port helper retry classification (cli#1025)", () => {
  test("only EADDRINUSE is an address-in-use error", () => {
    expect(isAddressInUse(coded("EADDRINUSE", "taken"))).toBe(true);
    expect(isAddressInUse(coded("EACCES", "Is port 1234 in use?"))).toBe(false);
    expect(isAddressInUse("Is port 1234 in use?")).toBe(false);
  });

  test("an EACCES carrying the address-in-use wording propagates on the first attempt", async () => {
    let attempts = 0;
    const failure = coded("EACCES", "Is port 1234 in use?");
    const error = await withPortRetry(async () => {
      attempts += 1;
      throw failure;
    }).catch((caught: unknown) => caught);

    expect(attempts).toBe(1);
    expect(error).toBe(failure);
  });

  test("EADDRINUSE retries and exhaustion reports the last error", async () => {
    let attempts = 0;
    const error = await withPortRetry(
      async () => {
        attempts += 1;
        throw coded("EADDRINUSE", `attempt ${attempts}`);
      },
      { attempts: 3 },
    ).catch((caught: unknown) => caught);

    expect(attempts).toBe(3);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("attempt 3");
  });

  test("the default attempt count is bounded", () => {
    expect(PORT_ATTEMPTS).toBe(5);
  });
});
