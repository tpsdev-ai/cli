import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const workflow = yaml.load(readFileSync(
  join(import.meta.dir, "../../../.github/workflows/dependency-audit.yml"), "utf8",
)) as { jobs: { notify: { steps: Array<{ run: string }> } } };
const title = "Dependency audit failure on main";

for (const mode of ["create", "comment", "list-failure", "write-failure"]) {
  test(`notification through real gh API: ${mode}`, async () => {
    const gh = Bun.which("gh");
    expect(gh, "GitHub CLI must be installed in this lane").not.toBeNull();
    const requests: Array<{ method: string; path: string; body?: Record<string, string> }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.json() as Record<string, string> : undefined;
        requests.push({ method: request.method, path: url.pathname, body });
        if (mode === "list-failure" || (mode === "write-failure" && request.method === "POST")) {
          return Response.json({ message: "fixture API failure" }, { status: 500 });
        }
        if (request.method === "POST") return Response.json({ number: 43 }, { status: 201 });
        if (url.searchParams.get("page") === "2") {
          return Response.json(mode === "comment" ? [{ number: 42, title, user: { login: "github-actions[bot]" } }] : []);
        }
        return Response.json([
          { number: 1, title, pull_request: {} },
          { number: 2, title: `${title} extra` },
          { number: 3, title, user: { login: "someone-else" } },
        ], {
          headers: { link: `<${url.origin}${url.pathname}?state=open&per_page=100&page=2>; rel="next"` },
        });
      },
    });
    const root = mkdtempSync(join(tmpdir(), "audit-real-gh-"));
    try {
      // Redirect the endpoint; argument parsing, pagination and jq run in gh.
      writeFileSync(join(root, "gh"), `#!/usr/bin/env bash
set -euo pipefail
args=()
for arg in "$@"; do
  case "$arg" in repos/*) arg="$TEST_API_URL/$arg" ;; esac
  args+=("$arg")
done
exec "$REAL_GH" "${'${args[@]}'}"
`, { mode: 0o700 });
      const child = Bun.spawn(["bash", "-c", workflow.jobs.notify.steps[0].run], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          REAL_GH: gh ?? "",
          TEST_API_URL: `http://127.0.0.1:${server.port}`,
          GH_TOKEN: "fixture-token",
          GH_HOST: "github.com",
          GH_NO_UPDATE_NOTIFIER: "1",
          REPOSITORY: "example/repo",
          SERVER_URL: "https://github.example",
          RUN_ID: "12345",
          MAIN_SHA: "a".repeat(40),
          ISSUE_TITLE: title,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (mode.endsWith("failure")) {
        expect(exit).not.toBe(0);
        expect(stderr).toContain("fixture API failure");
        if (mode === "list-failure") expect(requests).toHaveLength(1);
      } else {
        expect(exit, stderr).toBe(0);
        expect(requests).toHaveLength(3);
        const post = requests[2];
        expect(post.method).toBe("POST");
        expect(post.path).toBe(mode === "comment"
          ? "/repos/example/repo/issues/42/comments" : "/repos/example/repo/issues");
        expect(post.body?.body).toContain("https://github.example/example/repo/actions/runs/12345");
        expect(post.body?.body).toContain(`Main SHA: ${"a".repeat(40)}`);
        if (mode === "create") expect(post.body?.title).toBe(title);
      }
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
