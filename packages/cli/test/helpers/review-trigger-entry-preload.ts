import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { installStubFlairFetch, orgEventCatchupRoute, requestSigner } from "./stub-flair.js";

Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });

const root = process.env.HOME!;
const events: Record<string, unknown>[] = process.env.REVIEW_TASK_PATH === "flair" ? [{
  id: "task-event", kind: "task.assigned", authorId: "flint", targetIds: ["agent-a"],
  summary: "Implement change", detail: "Implement change", refId: "task-flair",
  createdAt: new Date().toISOString(),
}] : [];
const route = orgEventCatchupRoute({ events });
installStubFlairFetch({ "agent-a": Buffer.alloc(32, 0x31), flint: Buffer.alloc(32, 0x32) }, async (req, url, caller) => {
  if (url.pathname.startsWith("/OrgEventCatchup/")) {
    const response = route(req, url, caller);
    appendFileSync(join(root, "catchup.jsonl"), JSON.stringify({ served: route.served }) + "\n");
    return response;
  }
  if (url.pathname === "/OrgEvent" && req.method === "POST") {
    const event = { ...await req.json() as Record<string, unknown>, authorId: caller, id: `emitted-${events.length}`, createdAt: new Date().toISOString() };
    events.push(event);
    appendFileSync(join(root, "events.jsonl"), JSON.stringify(event) + "\n");
    return Response.json(event);
  }
  if (url.pathname.startsWith("/Agent/")) return undefined;
  if (req.method === "POST") return Response.json({});
  return Response.json([]);
});

const response = await fetch("http://flair.test/OrgEvent", {
  method: "POST",
  headers: { Authorization: requestSigner("flint", Buffer.alloc(32, 0x32))("POST", "/OrgEvent"), "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "pr.opened", authorId: "agent-a", targetIds: ["agent-a"], summary: "Forged author", detail: "https://github.com/example/repo/pull/999", refId: "forged" }),
});
if (!response.ok) throw new Error(`Foreign POST failed: ${response.status}`);
