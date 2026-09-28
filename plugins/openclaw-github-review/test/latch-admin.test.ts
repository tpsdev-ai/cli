/**
 * latch-admin.test.ts — the HOST's command for the dispatch latch store: it
 * lists and clears latches, refuses (and leaves untouched) a store it cannot
 * parse, and the BUILT program runs under node as a host command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileReconcileStore } from "../src/audit.js";
import { runLatchAdmin } from "../src/latch-admin.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-latch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runLatchAdmin(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

describe("latch-admin — the host clears a dispatch latch", () => {
  test("list shows every latch; clear removes exactly the named one", () => {
    const file = join(root, "reconcile.json");
    const store = new FileReconcileStore(file);
    store.add("d-1", "reconcile_required");
    store.add("d-2", "posted");
    expect(run(["list", file])).toEqual({ code: 0, out: ["d-1\treconcile_required", "d-2\tposted"], err: [] });
    expect(run(["clear", file, "d-1"])).toEqual({ code: 0, out: ["cleared d-1"], err: [] });
    expect(store.get("d-1")).toBeNull();
    expect(store.get("d-2")).toBe("posted");
    expect(run(["clear", file, "d-1"]).out).toEqual(["no latch for d-1"]);
  });

  test("a store it cannot parse is refused and left untouched", () => {
    const file = join(root, "reconcile.json");
    writeFileSync(file, '{"latches":[', { mode: 0o600 });
    const r = run(["clear", file, "d-1"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("could not be updated");
    expect(readFileSync(file, "utf8")).toBe('{"latches":[');
  });

  test("bad usage exits 2 and changes nothing", () => {
    const file = join(root, "reconcile.json");
    for (const argv of [[], ["clear", file], ["list"], ["drop", file, "d-1"], ["clear", file, "d-1", "extra"]]) {
      expect(run(argv).code).toBe(2);
    }
    expect(existsSync(file)).toBe(false);
  });

  test("the BUILT command runs under node", () => {
    const entry = join(pluginRoot, "dist", "src", "latch-admin.js");
    expect(existsSync(entry)).toBe(true);
    const file = join(root, "reconcile.json");
    new FileReconcileStore(file).add("d-9", "reconcile_required");
    const res = spawnSync("node", [entry, "clear", file, "d-9"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("cleared d-9");
    expect(new FileReconcileStore(file).get("d-9")).toBeNull();
  });
});
