/**
 * test/helpers/local-registry.ts — a loopback npm registry for tests.
 *
 * Serves package metadata (with a publish-time map) and tarballs, records every
 * request, and counts a request it does not serve as unexpected. Metadata
 * advertises the canonical public registry tarball URL, so a lockfile npm writes
 * from it carries canonical URLs and `npm ci` fetches the bytes from this server
 * by replacing the registry host (npm's default `replace-registry-host=npmjs`).
 *
 * A package serves metadata only when it carries a `time` map; without one the
 * metadata path answers 404 (the shape the tracked-lock tests already install
 * against). A package always serves its tarball at `/<name>/-/<basename>-<version>.tgz`.
 *
 * `unexpected` holds every request outside those paths; `assertNoUnexpected`
 * fails on it. A test that means to prove an unserved request failed reads
 * `unexpected` instead.
 */

import { createHash } from "node:crypto";

export type RegistryPackage = {
  /** Package name as the lockfile records it. */
  name: string;
  version: string;
  /** The generated tarball's bytes, served for this package. */
  tarball: Uint8Array;
  /**
   * Publish times by version. Present: metadata is served (a version missing
   * here has no publish time). Absent: the metadata path answers 404.
   */
  time?: Record<string, string>;
  /** The `dist.tarball` the metadata advertises; defaults to the public registry URL. */
  tarballUrl?: string;
};

export type LocalRegistry = {
  url: string;
  /** Every request, as `METHOD /path`, in arrival order. */
  requests: string[];
  /** Requests outside the paths this registry serves. */
  unexpected: string[];
  stop: () => void;
  /** Throws when any request fell outside the served set. */
  assertNoUnexpected: () => void;
  /** Advertise the package's tarball in its metadata, or withhold it (no `dist.tarball`). */
  setTarballAdvertised: (name: string, advertised: boolean) => void;
};

const PUBLIC_REGISTRY = "https://registry.npmjs.org";

/** The tarball file name npm gives a package: `<basename>-<version>.tgz`. */
function tarballFile(name: string, version: string): string {
  return `${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
}

/** The path a package's tarball is served at. */
export function tarballPath(name: string, version: string): string {
  return `/${name}/-/${tarballFile(name, version)}`;
}

/** The canonical public registry URL for a package tarball. */
export function publicTarballUrl(name: string, version: string): string {
  return `${PUBLIC_REGISTRY}${tarballPath(name, version)}`;
}

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** The packument npm reads: one version, its dist, and the publish-time map. */
function metadataFor(pkg: RegistryPackage, advertisedUrl: string | null): Record<string, unknown> {
  const dist: Record<string, string> = { integrity: integrityOf(pkg.tarball) };
  if (advertisedUrl !== null) dist.tarball = advertisedUrl;
  return {
    name: pkg.name,
    "dist-tags": { latest: pkg.version },
    versions: {
      [pkg.version]: { name: pkg.name, version: pkg.version, dist },
    },
    time: pkg.time,
  };
}

export function startLocalRegistry(packages: RegistryPackage[]): LocalRegistry {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const advertised = new Map<string, string | null>(
    packages.map((pkg) => [pkg.name, pkg.tarballUrl ?? publicTarballUrl(pkg.name, pkg.version)]),
  );
  const tarballs = new Map(packages.map((pkg) => [tarballPath(pkg.name, pkg.version), pkg.tarball]));
  const requests: string[] = [];
  const unexpected: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // A malformed escape is not a path this registry serves.
      }
      const metadata = byName.get(decoded.replace(/^\//, ""));
      if (metadata !== undefined) {
        if (metadata.time === undefined) {
          return new Response(`no metadata for ${metadata.name}`, { status: 404 });
        }
        const body = metadataFor(metadata, advertised.get(metadata.name) ?? null);
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }
      const tarball = tarballs.get(decoded);
      if (tarball !== undefined) {
        return new Response(tarball, { headers: { "content-type": "application/octet-stream" } });
      }
      unexpected.push(`${request.method} ${path}`);
      return new Response("unexpected request", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    unexpected,
    stop: () => {
      server.stop(true);
    },
    assertNoUnexpected: () => {
      if (unexpected.length > 0) {
        throw new Error(`the local registry saw requests outside the served set: ${unexpected.join(", ")}`);
      }
    },
    setTarballAdvertised: (name, isAdvertised) => {
      const pkg = byName.get(name);
      if (pkg === undefined) throw new Error(`no package ${name} in this registry`);
      advertised.set(name, isAdvertised ? (pkg.tarballUrl ?? publicTarballUrl(pkg.name, pkg.version)) : null);
    },
  };
}
