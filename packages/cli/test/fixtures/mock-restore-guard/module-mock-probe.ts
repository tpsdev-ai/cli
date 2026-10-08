// cli#555 regression probe: run by mock-restore-guard.test.ts in a child bun
// process. It shows that mock.restore() does not undo mock.module() on bun
// 1.3.10: a later consumer of the module still receives the replacement. That
// is why the scanner rejects mock.module() in a shared-process test file.
// Run with `bun test ./module-mock-probe.ts` from this directory; the file is
// not named *.test.ts, so bun does not discover it automatically.
import { afterEach, mock, test } from "bun:test";

const target = new URL("./module-mock-probe-target.ts", import.meta.url).href;

afterEach(() => {
  mock.restore();
});

test("registers a module mock", async () => {
  mock.module(target, () => ({ marker: "MOCKED" }));
  const mod = await import(target);
  console.log("FIRST=" + mod.marker);
});

test("a later consumer still receives the replacement after the restore", async () => {
  const mod = await import(target);
  console.log("SECOND=" + mod.marker);
});
