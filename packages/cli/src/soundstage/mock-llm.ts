import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_RESPONSES = [
  "I'll check my mail now.",
  "Task received. Working on it.",
  "Work complete. Sending results.",
  "HEARTBEAT_OK",
];

interface ScriptEntry {
  content: string;
}

function loadScript(scriptPath?: string): string[] {
  if (scriptPath && existsSync(scriptPath)) {
    try {
      const raw = JSON.parse(readFileSync(scriptPath, "utf-8"));
      if (Array.isArray(raw)) return raw.map((r: ScriptEntry) => r.content || String(r));
    } catch {}
  }
  return DEFAULT_RESPONSES;
}

export function startMockLLM(port = 11434, scriptPath?: string): ReturnType<typeof createServer> {
  const responses = loadScript(scriptPath);
  let index = 0;

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/v1/chat/completions")) {
      // Consume request body but don't use it (no echo — security invariant)
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const response = responses[index % responses.length]!;
        index++;

        const body = JSON.stringify({
          id: `mock-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mock-soundstage",
          choices: [{
            index: 0,
            message: { role: "assistant", content: response },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      });
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // SECURITY: bind to loopback only, never 0.0.0.0
  server.listen(port, "127.0.0.1", () => {
    console.log(`Mock LLM listening on http://127.0.0.1:${port}/v1`);
  });

  return server;
}

// CLI mode: run standalone
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("mock-llm.ts")) {
  const port = Number(process.env.MOCK_LLM_PORT || 11434);
  const script = process.env.MOCK_LLM_SCRIPT;
  startMockLLM(port, script);
}
