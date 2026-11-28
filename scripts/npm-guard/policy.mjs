// npm guard policy (cli#948, slice 1a): the allowed argv shapes, keyed by
// GITHUB_JOB. Nothing here is wired into CI yet.
//
// Boundary (cli#948 design v2): the guard mediates the npm and npx spellings
// that the lint enumerates; it does not decide who may call the real npm. The
// threat model is unreviewed drift, not confinement.
//
// decide() is pure: it reads no environment, no file and no process. The verb
// is argv[0], matched exactly (no prefix, abbreviation or alias resolution); a
// flag before the verb is refused; every token is matched against the shape's
// template, so an unlisted flag is refused. A job not in the table allows
// nothing but the version probe.

import { scriptShellPath } from "./paths.mjs";

const REGISTRY = "https://registry.npmjs.org";

// Slot tokens: a template position filled by a value with a bounded spelling.
const SPEC = { slot: "spec" };
const NPM_VERSION = { slot: "npm-version" };

// A package name, scoped or not, with an optional @version. No token can start
// with `-` and none admits a shell metacharacter or whitespace.
const SPEC_RE =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
// The same exact-version shape the static global-install lint accepts.
const NPM_VERSION_RE = /^npm@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHELL_METACHAR_RE = /[$`'"';&|<>(){}]|\\/;

// Every shape a CI job runs today, with the caller it was built from.
export const TABLE = [
  // test.yml `test` job.
  { job: "test", argv: ["run", "build"], callers: ["test.yml:194", "test.yml:203"] },
  { job: "test", argv: ["run", "typecheck:test"], callers: ["test.yml:204"] },
  // test.yml `node-plugin-load` job.
  { job: "node-plugin-load", argv: ["run", "build"], callers: ["test.yml:261"] },
  // test.yml `github-review-gateway-boundary` job.
  {
    job: "github-review-gateway-boundary",
    argv: ["run", "build"],
    callers: ["test.yml:367"],
  },
  {
    job: "github-review-gateway-boundary",
    argv: ["run", "typecheck:test"],
    callers: ["test.yml:368"],
  },
  // test.yml `promote-latest-fixtures` job runs scripts/promote-latest.sh, which
  // pins every call with `--registry "$NPM_REGISTRY"` (default cited below).
  {
    job: "promote-latest-fixtures",
    argv: ["view", SPEC, "version", "--registry", REGISTRY],
    callers: ["promote-latest.sh:361"],
  },
  {
    job: "promote-latest-fixtures",
    argv: ["view", SPEC, "dist-tags.latest", "--registry", REGISTRY],
    callers: ["promote-latest.sh:399", "promote-latest.sh:562", "promote-latest.sh:711", "promote-latest.sh:730"],
  },
  {
    job: "promote-latest-fixtures",
    argv: ["dist-tag", "add", SPEC, "latest", "--registry", REGISTRY],
    callers: ["promote-latest.sh:547", "promote-latest.sh:699"],
  },
  // docker.yml `meta` job runs .github/scripts/docker-image-tags.sh, whose only
  // npm call takes the default registry and no flag.
  { job: "meta", argv: ["view", SPEC, "version"], callers: ["docker-image-tags.sh:59"] },
  // release.yml `publish-packages` job.
  {
    job: "publish-packages",
    argv: ["install", "-g", NPM_VERSION, `--registry=${REGISTRY}`],
    callers: ["release.yml:256"],
  },
  {
    job: "publish-packages",
    argv: ["stage", "publish", "--tag", "staged", "--access", "public"],
    callers: ["release.yml:414"],
  },
  { job: "publish-packages", argv: ["view", SPEC, "version"], callers: ["release.yml:421"] },
];

export const TABLE_SIZE = TABLE.length;

function refuse(reason) {
  return { allow: false, reason };
}

function tokenMatches(pattern, token) {
  if (typeof pattern === "string") return pattern === token;
  if (pattern.slot === "spec") return SPEC_RE.test(token);
  if (pattern.slot === "npm-version") return NPM_VERSION_RE.test(token);
  return false;
}

function shapeMatches(pattern, argv) {
  if (pattern.length !== argv.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (!tokenMatches(pattern[i], argv[i])) return false;
  }
  return true;
}

// cli#948 design v2 item 5: the run family gets the guard's `--script-shell`
// appended, so package and lifecycle scripts reach the shims.
export function needsScriptShell(argv) {
  const verb = argv[0];
  if (verb === "stage") return argv[1] === "publish";
  return ["run", "run-script", "test", "start", "stop", "restart", "pack"].includes(verb);
}

export function decide(tool, argv, job) {
  const args = Array.isArray(argv) ? argv : [];

  if (tool === "npx") return refuse("npx has no allowed command shapes");
  if (tool !== "npm") return refuse("only npm and npx are mediated");

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return { allow: true, argv: [...args] };
  }

  if (args.length === 0) return refuse("no command was given");
  if (args[0].startsWith("-")) return refuse("a flag precedes the verb");
  if (args[0] === "version") return refuse("the version verb is refused; use --version or -v");

  // The one global install shape also refuses shell metacharacters outright.
  if (args[0] === "install" && args.some((token) => SHELL_METACHAR_RE.test(token))) {
    return refuse("the global install shape admits no shell metacharacters");
  }

  const entry = TABLE.find((candidate) => candidate.job === job && shapeMatches(candidate.argv, args));
  if (!entry) return refuse("the command shape is not allowed in this job");

  if (needsScriptShell(args)) {
    return { allow: true, argv: [...args, "--script-shell", scriptShellPath()] };
  }
  return { allow: true, argv: [...args] };
}
