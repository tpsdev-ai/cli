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
 * Two cases exclude a transitive dependency and pin it with an exact override:
 * Bun applies the override from the root package.json and the gate accepts it;
 * Bun ignores it in a workspace package.json and the gate refuses it.
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectResolvedDeps, parseBunLock } from "../scripts/lib/check-dep-ages-collect.mjs";

const GATE = fileURLToPath(new URL("../scripts/check-dep-ages.mjs", import.meta.url));

const NAME = "@tpsdev-ai/age-fixture";
const AGED = "1.0.0"; // published 90 days before the run
const FRESH = "1.1.0"; // published 1 day before the run
const WINDOW_SECONDS = 604800;
const BLOCKED = `blocked by minimum-release-age: ${WINDOW_SECONDS} seconds`;

type Published = Record<string, Record<string, { ageDays: number; dependencies?: Record<string, string> }>>;
const AGE_FIXTURE: Published = { [NAME]: { [AGED]: { ageDays: 90 }, [FRESH]: { ageDays: 1 } } };

/** No external network (loopback-only local registry). The last version listed is `latest`. */
function startRegistry(root: string, published: Published = AGE_FIXTURE) {
  const tarballs = new Map<string, Buffer>();
  for (const [name, versions] of Object.entries(published)) {
    for (const [version, { dependencies = {} }] of Object.entries(versions)) {
      const source = join(root, "src", name, version);
      mkdirSync(join(source, "package"), { recursive: true });
      writeFileSync(join(source, "package", "package.json"), JSON.stringify({ name, version, dependencies }));
      const archive = join(source, "package.tgz");
      const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package"]);
      expect(packed.status).toBe(0);
      tarballs.set(`${name}/-/${version}`, readFileSync(archive));
    }
  }
  const requests: string[] = [];
  const now = Date.now();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      const tarball = url.pathname.match(/^\/tar\/(.*)\.tgz$/)?.[1];
      if (tarball) {
        const archive = tarballs.get(tarball);
        return archive ? new Response(archive) : new Response("missing", { status: 404 });
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const listed = Object.hasOwn(published, name) ? Object.entries(published[name]) : [];
      if (listed.length === 0) return new Response("missing", { status: 404 });
      const versions: Record<string, unknown> = {};
      const time: Record<string, string> = {};
      for (const [v, { ageDays, dependencies = {} }] of listed) {
        const archive = tarballs.get(`${name}/-/${v}`) as Buffer;
        versions[v] = {
          name,
          version: v,
          dependencies,
          dist: {
            tarball: `${url.origin}/tar/${name}/-/${v}.tgz`,
            shasum: createHash("sha1").update(archive).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
          },
        };
        time[v] = new Date(now - ageDays * 86400000).toISOString();
      }
      return Response.json({ name, "dist-tags": { latest: listed[listed.length - 1][0] }, versions, time });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

const dependsOn = (spec: string) => ({ "package.json": { name: "fixture", dependencies: { [NAME]: spec } } });

/** Write a project dir from the given manifests; `lock` is seeded byte for byte. */
function writeProject(
  root: string,
  manifests: Record<string, unknown>,
  registry: string,
  opts: { excludes?: string[]; lock?: string } = {},
) {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  for (const [path, json] of Object.entries(manifests)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), JSON.stringify(json));
  }
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
      const fresh = writeProject(root, dependsOn(FRESH), registry.url);
      const first = await bunInstall(fresh, ["--no-cache"]);
      expect(first.exit).not.toBe(0);
      expect(first.output).toContain(BLOCKED);
      expect(first.output).toContain(NAME);
      expect(first.output).toContain(FRESH);
      expect(lockVersions(fresh)).not.toContainEqual({ name: NAME, version: FRESH });

      // A lockfile that pins the aged version, asked to install the too-young one.
      const frozen = writeProject(root, dependsOn("^1.0.0"), registry.url);
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
      const project = writeProject(root, dependsOn(FRESH), registry.url, { excludes: [NAME] });
      const install = await bunInstall(project, ["--no-cache"]);
      expect({ exit: install.exit, output: install.output }).toMatchObject({ exit: 0 });
      expect(lockVersions(project)).toEqual([{ name: NAME, version: FRESH }]);
      expect(registry.requests).toContain(`/tar/${NAME}/-/${FRESH}.tgz`);

      // A complete lockfile installs the excluded too-young version under --frozen-lockfile.
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

const PARENT = "@tpsdev-ai/age-parent";
const CHILD = "@tpsdev-ai/age-child";
const PINNED = "1.1.0"; // the override's target; the parent's range alone takes the latest, 1.2.0
const OVERRIDE_FIXTURE: Published = {
  [PARENT]: { "1.0.0": { ageDays: 90, dependencies: { [CHILD]: "^1.0.0" } } },
  [CHILD]: { "1.0.0": { ageDays: 90 }, [PINNED]: { ageDays: 1 }, "1.2.0": { ageDays: 1 } },
};

/** Run the CI gate on a project; async, so the in-process registry keeps serving. */
async function runGate(project: string, registry: string, exception: string) {
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(
    join(project, "docs", "dep-age-exceptions.md"),
    `## Exceptions\n- ${exception} | expires:9999-12-31 | reason: fixture\n`,
  );
  const gate = Bun.spawn(["node", GATE], {
    env: { PATH: process.env.PATH ?? "", TPS_DEP_AGES_ROOT: project, TPS_DEP_AGES_REGISTRY: registry },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
  });
  const output = (await new Response(gate.stdout).text()) + (await new Response(gate.stderr).text());
  return { exit: await gate.exited, output };
}

it(
  "Bun applies an exact root override to an excluded transitive dependency, and the gate accepts it",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "age-override-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    try {
      registry = startRegistry(root, OVERRIDE_FIXTURE);
      const manifest = { name: "fixture", dependencies: { [PARENT]: "1.0.0" }, overrides: { [CHILD]: PINNED } };
      const project = writeProject(root, { "package.json": manifest }, registry.url, { excludes: [CHILD] });
      const install = await bunInstall(project, ["--no-cache"]);
      expect({ exit: install.exit, output: install.output }).toMatchObject({ exit: 0 });
      expect(lockVersions(project).filter((d) => d.name === CHILD)).toEqual([{ name: CHILD, version: PINNED }]);

      const gate = await runGate(project, registry.url, `${CHILD}@${PINNED}`);
      expect({ exit: gate.exit, output: gate.output }).toMatchObject({ exit: 0 });
      expect(gate.output).toContain(`${CHILD}@${PINNED} — until 9999-12-31`);
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
  "Bun ignores the override in a workspace package.json, and the gate refuses it",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "age-ws-override-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    try {
      registry = startRegistry(root, OVERRIDE_FIXTURE);
      const workspace = join("packages", "w", "package.json");
      const project = writeProject(
        root,
        {
          "package.json": { name: "fixture", workspaces: ["packages/*"] },
          [workspace]: { name: "w", dependencies: { [PARENT]: "1.0.0" }, overrides: { [CHILD]: PINNED } },
        },
        registry.url,
        { excludes: [CHILD] },
      );
      const install = await bunInstall(project, ["--no-cache"]);
      expect({ exit: install.exit, output: install.output }).toMatchObject({ exit: 0 });
      expect(lockVersions(project).filter((d) => d.name === CHILD)).toEqual([{ name: CHILD, version: "1.2.0" }]);

      const gate = await runGate(project, registry.url, `${CHILD}@1.2.0`);
      expect(gate.exit).toBe(2);
      expect(gate.output).toContain(
        `${workspace}: \`${CHILD}\` is in overrides, which Bun applies from the root package.json, not from this file.`,
      );
      expect(gate.output).not.toContain("Checking");
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
