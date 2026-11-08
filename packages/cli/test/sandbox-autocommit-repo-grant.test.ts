/**
 * cli#833 — the sandboxed launch's auto-commit repository must sit inside one
 * of the sandbox's write grants. These cases pin the containment check: real
 * paths on both sides and a path-segment boundary.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCommitRepoGrantRefusal, writeGrantCovers } from "../src/utils/nono.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-grant-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cli#833 — write-grant containment", () => {
  test("a repository inside the grant is covered", () => {
    const grant = join(root, "work", "agent");
    mkdirSync(join(grant, "repo"), { recursive: true });
    expect(writeGrantCovers(grant, join(grant, "repo"))).toBe(true);
  });

  test("the workspace itself is covered", () => {
    const grant = join(root, "work", "agent");
    mkdirSync(grant, { recursive: true });
    expect(writeGrantCovers(grant, grant)).toBe(true);
  });

  test("a sibling with the grant as a string prefix is not inside it", () => {
    const grant = join(root, "a", "b");
    const sibling = join(root, "a", "bc");
    mkdirSync(grant, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    expect(writeGrantCovers(grant, sibling)).toBe(false);
  });

  test("a path outside every grant is not covered", () => {
    const grant = join(root, "work", "agent");
    mkdirSync(grant, { recursive: true });
    expect(writeGrantCovers(grant, join(root, "elsewhere", "repo"))).toBe(false);
  });

  test("a symlink resolving INTO the grant is covered", () => {
    const grant = join(root, "work", "agent");
    const inside = join(grant, "repo");
    mkdirSync(inside, { recursive: true });
    const link = join(root, "link-into");
    symlinkSync(inside, link);
    expect(writeGrantCovers(grant, link)).toBe(true);
  });

  test("a symlink under the grant resolving OUT of it is not covered", () => {
    const grant = join(root, "work", "agent");
    const outside = join(root, "elsewhere", "repo");
    mkdirSync(grant, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(grant, "escape");
    symlinkSync(outside, link);
    expect(writeGrantCovers(grant, link)).toBe(false);
  });
});

describe("cli#833 — the launch refusal", () => {
  test("names the repository, the grants and the remedy", () => {
    const workspace = join(root, "work", "agent");
    const mailDir = join(root, "mail");
    const agentDir = join(root, "state", "agent");
    const outside = join(root, "elsewhere", "repo");
    for (const d of [workspace, mailDir, agentDir, outside]) mkdirSync(d, { recursive: true });
    const refusal = autoCommitRepoGrantRefusal(outside, {
      workdir: workspace,
      cwd: workspace,
      allow: [mailDir, workspace, agentDir],
      allowFiles: [],
    });
    expect(refusal).toContain(`autoCommit.repo '${outside}'`);
    expect(refusal).toContain(workspace);
    expect(refusal).toContain(agentDir);
    expect(refusal).toContain("put the repository under the workspace, or run that agent without the sandbox");
  });

  test("is null for a repository inside a grant", () => {
    const workspace = join(root, "work", "agent");
    mkdirSync(join(workspace, "repo"), { recursive: true });
    expect(
      autoCommitRepoGrantRefusal(join(workspace, "repo"), {
        workdir: workspace,
        cwd: workspace,
        allow: [workspace],
      }),
    ).toBeNull();
  });
});
