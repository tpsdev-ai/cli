import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectResolvedDeps, parseBunLock } from "../scripts/lib/check-dep-ages-collect.mjs";

const GATE = fileURLToPath(new URL("../scripts/check-dep-ages.mjs", import.meta.url));
const NAME = "@tpsdev-ai/age-fixture";

async function checkResolution(spec: string, expectedVersion: string | null) {
  const root = mkdtempSync(join(tmpdir(), "age-bun-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const tarballs = new Map<string, Buffer>();
    for (const version of ["1.0.0", "1.1.0"]) {
      const source = join(root, version);
      mkdirSync(join(source, "package"), { recursive: true });
      writeFileSync(join(source, "package", "package.json"), JSON.stringify({ name: NAME, version }));
      const archive = join(root, `${version}.tgz`);
      const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package"]);
      expect(packed.status).toBe(0);
      tarballs.set(version, readFileSync(archive));
    }
    const requests: string[] = [];
    const now = Date.now();
    const times = {
      "1.0.0": new Date(now - 90 * 86400000).toISOString(),
      "1.1.0": new Date(now - 86400000).toISOString(),
    };
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push(url.pathname);
        const version = url.pathname.match(/^\/tar\/(.*)\.tgz$/)?.[1];
        if (version) {
          const archive = tarballs.get(version);
          return archive ? new Response(archive) : new Response("missing", { status: 404 });
        }
        if (decodeURIComponent(url.pathname.slice(1)) !== NAME) return new Response("missing", { status: 404 });
        const versions = Object.fromEntries([...tarballs].map(([v, archive]) => [v, {
          name: NAME, version: v,
          dist: {
            tarball: `${url.origin}/tar/${v}.tgz`,
            shasum: createHash("sha1").update(archive).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
          },
        }]));
        return Response.json({ name: NAME, "dist-tags": { latest: "1.1.0" }, versions, time: times });
      },
    });
    const registry = `http://127.0.0.1:${server.port}`;
    const project = join(root, "project");
    const home = join(root, "home");
    mkdirSync(join(project, "docs"), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", dependencies: { [NAME]: spec } }));
    writeFileSync(join(project, "bunfig.toml"), `[install]\nminimumReleaseAge = 604800\nregistry = "${registry}"\n`);
    writeFileSync(join(project, "docs", "dep-age-exceptions.md"), "## Exceptions\n");
    const env = {
      PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root,
      BUN_INSTALL_CACHE_DIR: join(root, "cache"),
    };
    const install = Bun.spawn([process.execPath, "install", "--ignore-scripts", "--no-cache"], {
      cwd: project, env, stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    const installOutput = await new Response(install.stdout).text() + await new Response(install.stderr).text();
    const installExit = await install.exited;
    const lockPath = join(project, "bun.lock");
    if (expectedVersion === null) {
      expect(installExit).not.toBe(0);
      expect(installOutput).toContain("blocked by minimum-release-age: 604800 seconds");
      expect(installOutput).toContain(NAME);
      expect(installOutput).toContain(spec);
      const deps = existsSync(lockPath) ? collectResolvedDeps(parseBunLock(readFileSync(lockPath, "utf8"))) : [];
      expect(deps).not.toContainEqual({ name: NAME, version: spec });
      return;
    }
    expect({ exit: installExit, output: installOutput }).toMatchObject({ exit: 0 });
    expect(collectResolvedDeps(parseBunLock(readFileSync(lockPath, "utf8")))).toEqual([
      { name: NAME, version: expectedVersion },
    ]);
    expect(requests).toContain(`/tar/${expectedVersion}.tgz`);
    const gate = Bun.spawn(["node", GATE], {
      env: { ...env, TPS_DEP_AGES_ROOT: project, TPS_DEP_AGES_REGISTRY: registry },
      stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    const output = await new Response(gate.stdout).text() + await new Response(gate.stderr).text();
    expect({ exit: await gate.exited, output }).toMatchObject({ exit: 0 });
  } finally {
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

it("Bun selects an aged version for a fresh range and the lock gate accepts it", async () => {
  await checkResolution("^1.0.0", "1.0.0");
}, 60000);

it("Bun refuses a young exact pin and writes no lock entry for it", async () => {
  await checkResolution("1.1.0", null);
}, 60000);
