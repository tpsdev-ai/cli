/**
 * test/check-dep-ages-install-age-bun.test.ts — the install-time half of the
 * release-age policy (cli#572), exercised against a real Bun.
 *
 * bunfig.toml's `[install] minimumReleaseAge` is enforced by Bun while it
 * resolves, so a hermetic local registry publishes one aged and one too-young
 * version and real `bun install` runs against it. The cases cover what the
 * lock gate (scripts/check-dep-ages.mjs) cannot: that the install-time gate
 * refuses a too-young version on a fresh resolve and when the lockfile must
 * change, and that adding the name to `minimumReleaseAgeExcludes` admits it.
 *
 * No external network (loopback-only local registry). Setup runs inside `try`;
 * `finally` stops the registry if started and removes the temporary tree.
 * Every spawned install carries an explicit timeout.
 */

import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectResolvedDeps, parseBunLock } from "../scripts/lib/check-dep-ages-collect.mjs";

const NAME = "@tpsdev-ai/age-fixture";
const AGED = "1.0.0"; // published 90 days before the run
const FRESH = "1.1.0"; // published 1 day before the run
const WINDOW_SECONDS = 604800;
const BLOCKED = `blocked by minimum-release-age: ${WINDOW_SECONDS} seconds`;

/** No external network (loopback-only local registry). */
function startRegistry(root: string) {
  const tarballs = new Map<string, Buffer>();
  for (const version of [AGED, FRESH]) {
    const source = join(root, `src-${version}`);
    mkdirSync(join(source, "package"), { recursive: true });
    writeFileSync(join(source, "package", "package.json"), JSON.stringify({ name: NAME, version }));
    const archive = join(root, `${version}.tgz`);
    const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package"]);
    expect(packed.status).toBe(0);
    tarballs.set(version, readFileSync(archive));
  }
  const requests: string[] = [];
  const now = Date.now();
  const time = {
    [AGED]: new Date(now - 90 * 86400000).toISOString(),
    [FRESH]: new Date(now - 86400000).toISOString(),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      const version = url.pathname.match(/^\/tar\/(.*)\.tgz$/)?.[1];
      if (version) {
        const archive = tarballs.get(version);
        return archive ? new Response(archive) : new Response("missing", { status: 404 });
      }
      if (decodeURIComponent(url.pathname.slice(1)) !== NAME) return new Response("missing", { status: 404 });
      const versions = Object.fromEntries(
        [...tarballs].map(([v, archive]) => [
          v,
          {
            name: NAME,
            version: v,
            dist: {
              tarball: `${url.origin}/tar/${v}.tgz`,
              shasum: createHash("sha1").update(archive).digest("hex"),
              integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
            },
          },
        ]),
      );
      return Response.json({ name: NAME, "dist-tags": { latest: FRESH }, versions, time });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** Write a project dir with the given dependency spec; `lock` is seeded byte for byte. */
function writeProject(root: string, spec: string, registry: string, opts: { excludes?: string[]; lock?: string } = {}) {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", dependencies: { [NAME]: spec } }));
  const lines = ["[install]", `minimumReleaseAge = ${WINDOW_SECONDS}`];
  if ((opts.excludes ?? []).length > 0) {
    lines.push(`minimumReleaseAgeExcludes = [${opts.excludes?.map((n) => `"${n}"`).join(", ")}]`);
  }
  lines.push(`registry = "${registry}"`);
  writeFileSync(join(project, "bunfig.toml"), lines.join("\n") + "\n");
  if (opts.lock !== undefined) writeFileSync(join(project, "bun.lock"), opts.lock);
  return project;
}

async function bunInstall(project: string, args: string[]) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(project, "..", "home"),
    TMPDIR: join(project, ".."),
    BUN_INSTALL_CACHE_DIR: join(project, "..", "cache"),
  };
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts", ...args], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
  });
  const output = (await new Response(install.stdout).text()) + (await new Response(install.stderr).text());
  return { exit: await install.exited, output };
}

function lockVersions(project: string) {
  const path = join(project, "bun.lock");
  return existsSync(path) ? collectResolvedDeps(parseBunLock(readFileSync(path, "utf8"))) : [];
}

it(
  "real Bun refuses a too-young version on a fresh resolve and under --frozen-lockfile",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "age-install-age-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    try {
      registry = startRegistry(root);
      // A fresh resolve of an exact pin that only the too-young version satisfies.
      const fresh = writeProject(root, FRESH, registry.url);
      const first = await bunInstall(fresh, ["--no-cache"]);
      expect(first.exit).not.toBe(0);
      expect(first.output).toContain(BLOCKED);
      expect(first.output).toContain(NAME);
      expect(first.output).toContain(FRESH);
      expect(lockVersions(fresh)).not.toContainEqual({ name: NAME, version: FRESH });

      // A lockfile that pins the aged version, asked to install the too-young one.
      const frozen = writeProject(root, "^1.0.0", registry.url);
      const generated = await bunInstall(frozen, []);
      expect({ exit: generated.exit, output: generated.output }).toMatchObject({ exit: 0 });
      expect(lockVersions(frozen)).toEqual([{ name: NAME, version: AGED }]);
      writeFileSync(join(frozen, "package.json"), JSON.stringify({ name: "fixture", dependencies: { [NAME]: FRESH } }));
      const second = await bunInstall(frozen, ["--frozen-lockfile", "--no-cache"]);
      expect(second.exit).not.toBe(0);
      expect(second.output).toContain(BLOCKED);
      expect(lockVersions(frozen)).toEqual([{ name: NAME, version: AGED }]);
    } finally {
      try {
        registry?.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  60000,
);

it(
  "adding the package to minimumReleaseAgeExcludes admits the too-young version",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "age-exclude-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    try {
      registry = startRegistry(root);
      const project = writeProject(root, FRESH, registry.url, { excludes: [NAME] });
      const install = await bunInstall(project, ["--no-cache"]);
      expect({ exit: install.exit, output: install.output }).toMatchObject({ exit: 0 });
      expect(lockVersions(project)).toEqual([{ name: NAME, version: FRESH }]);
      expect(registry.requests).toContain(`/tar/${FRESH}.tgz`);

      // A complete lockfile installs the too-young version without an age check.
      const recheck = await bunInstall(project, ["--frozen-lockfile", "--no-cache"]);
      expect({ exit: recheck.exit, output: recheck.output }).toMatchObject({ exit: 0 });
    } finally {
      try {
        registry?.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  60000,
);
