/**
 * cli#1025 — no test may choose a port by binding port 0, closing it, and
 * handing the number to a listener that binds it later: another process can
 * take the port in between. In-process listeners bind port 0 themselves; a
 * child that binds from config starts through `test/helpers/port.ts`, which
 * retries a taken port. This scan fails on a new pick-then-bind helper.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const TEST_ROOT = import.meta.dir;
const CLI_ROOT = resolve(TEST_ROOT, "..");
/** The one shared helper: it owns the retry, so its own pick is expected. */
const SHARED_HELPER = join(TEST_ROOT, "helpers", "port.ts");

export interface PortFinding {
  file: string;
  name: string;
}

/** True when the body binds port 0 and closes that listener before returning. */
function picksThenCloses(body: ts.Node): boolean {
  let bindsZero = false;
  let closes = false;
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "listen") {
        const first = child.arguments[0];
        if (first && ts.isNumericLiteral(first) && first.text === "0") bindsZero = true;
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "close") closes = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
  return bindsZero && closes;
}

/** A name that says the function hands out a port. */
const PORT_HELPER_NAME = /(^|[^a-z])(free|pick|choose|find|get)[A-Za-z]*Ports?$/i;

/** Every pick-then-bind port helper in `source`. */
export function analyzeSource(source: string, name: string): PortFinding[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: PortFinding[] = [];
  const record = (type: ts.TypeNode | undefined, body: ts.Node | undefined, functionName: string) => {
    if (!body || !picksThenCloses(body)) return;
    const declaredPort =
      type !== undefined && /^(Promise<number>|number)$/.test(type.getText().replace(/\s+/g, ""));
    if (!declaredPort && !PORT_HELPER_NAME.test(functionName)) return;
    findings.push({ file: name, name: functionName });
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) record(node.type, node.body, node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const fn = node.initializer;
      record(node.type ?? fn.type, fn.body, node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** Every source file under the cli test tree, except fixtures and the shared helper. */
function testTreeSources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "fixtures") continue;
        walk(path);
      } else if (entry.endsWith(".ts") && path !== SHARED_HELPER) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("port helper guard (cli#1025)", () => {
  test("no cli test file defines its own pick-then-bind port helper", () => {
    const offenders = testTreeSources(join(CLI_ROOT, "test"))
      .flatMap((file) => analyzeSource(readFileSync(file, "utf8"), relative(CLI_ROOT, file)));
    expect(offenders).toEqual([]);
  });

  test("reports a planted freePort helper (red fixture)", () => {
    const planted = `
      import net from "node:net";
      async function freePort(): Promise<number> {
        return new Promise((resolve, reject) => {
          const server = net.createServer();
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return reject(new Error("no address"));
            server.close(() => resolve(address.port));
          });
        });
      }`;
    expect(analyzeSource(planted, "planted.test.ts")).toEqual([
      { file: "planted.test.ts", name: "freePort" },
    ]);
  });

  test("clears a helper that keeps its listener open", () => {
    const holds = `
      function holdPort(): Promise<{ server: net.Server; port: number }> {
        return new Promise((resolvePort) => {
          const server = net.createServer();
          server.listen(0, "127.0.0.1", () => resolvePort({ server, port: 1 }));
        });
      }`;
    expect(analyzeSource(holds, "holds.test.ts")).toEqual([]);
  });
});
