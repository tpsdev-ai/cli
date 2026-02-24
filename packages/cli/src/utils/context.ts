import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface WorkstreamContext {
  workstream: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

function assertValidWorkstream(workstream: string): void {
  if (workstream.length > 64) {
    throw new Error("Invalid workstream: max length is 64 characters.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(workstream)) {
    throw new Error(
      `Invalid workstream "${workstream}". Use only letters, numbers, underscores, and hyphens.`
    );
  }
}

export function getContextDir(): string {
  // Per-workspace context (avoid polluting ~/.openclaw root config directory).
  // Can be overridden explicitly for tests/tooling.
  return (
    process.env.TPS_CONTEXT_DIR ||
    join(process.env.HOME || homedir(), ".tps", "context")
  );
}

function contextPath(workstream: string): string {
  assertValidWorkstream(workstream);
  return join(getContextDir(), `${workstream}.json`);
}

export function readContext(workstream: string): WorkstreamContext | null {
  const file = contextPath(workstream);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf-8");
  return JSON.parse(raw) as WorkstreamContext;
}

export function writeContext(
  workstream: string,
  data: Pick<WorkstreamContext, "summary"> & Partial<Pick<WorkstreamContext, "createdAt" | "updatedAt">>
): WorkstreamContext {
  const dir = getContextDir();
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const existing = readContext(workstream);

  const record: WorkstreamContext = {
    workstream,
    summary: data.summary,
    createdAt: existing?.createdAt || data.createdAt || now,
    updatedAt: data.updatedAt || now,
  };

  const file = contextPath(workstream);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, file);

  return record;
}

export function listContexts(): Array<{ workstream: string; updatedAt: string }> {
  const dir = getContextDir();
  if (!existsSync(dir)) return [];

  const rows = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const workstream = f.replace(/\.json$/, "");
      const file = join(dir, f);
      let updatedAt: string;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<WorkstreamContext>;
        updatedAt = parsed.updatedAt || statSync(file).mtime.toISOString();
      } catch {
        updatedAt = statSync(file).mtime.toISOString();
      }
      return { workstream, updatedAt };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  return rows;
}
