/**
 * cli#1025 — no test may choose a port by binding port 0, closing that
 * listener, and using the number for a bind later: another process can take
 * the port in between. This scan follows a server through `listen(0)` →
 * `address().port` → `close` → a later `listen` of that port, by the shape of
 * the code rather than a helper's name or type annotation, so a renamed or
 * untyped copy and an inline anonymous block are found too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const TEST_ROOT = import.meta.dir;
const CLI_ROOT = resolve(TEST_ROOT, "..");
/** The one shared helper: it owns the pick, so its own code is expected. */
const SHARED_HELPER = join(TEST_ROOT, "helpers", "port.ts");

export interface PortFinding {
  file: string;
  name: string;
  line: number;
}

const MAX_PROPAGATION_PASSES = 5;

interface Analysis {
  bindZero: Map<string, number[]>;
  close: Map<string, number[]>;
  address: Set<string>;
  portNameSource: Map<string, string>;
  addressNameSource: Map<string, string>;
  functionSource: Map<string, string>;
  bindArguments: Array<{ expression: ts.Expression; offset: number }>;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function callName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** The text of the receiver of `receiver.method(...)`, if it has that shape. */
function receiverText(call: ts.CallExpression, method: string): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (call.expression.name.text !== method) return undefined;
  return call.expression.expression.getText();
}

/** The receiver of `<receiver>.address()`, if `expression` is that call. */
function addressReceiver(expression: ts.Expression): string | undefined {
  const inner = unwrap(expression);
  return ts.isCallExpression(inner) ? receiverText(inner, "address") : undefined;
}

/**
 * The receiver whose port `expression` reads: `(s.address() as X).port` and
 * `s.address().port` have the shape; `address.port`/`port` are resolved through
 * the binding maps by the caller.
 */
function directPortReceiver(expression: ts.Expression): string | undefined {
  const inner = unwrap(expression);
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === "port") {
    return addressReceiver(inner.expression);
  }
  if (
    ts.isElementAccessExpression(inner) &&
    ts.isStringLiteral(inner.argumentExpression) &&
    inner.argumentExpression.text === "port"
  ) {
    return addressReceiver(inner.expression);
  }
  return undefined;
}

/** The name a function is known by: its own, or the variable/property it is assigned to. */
function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/** The nearest named function around `node`, or `<anonymous>` when there is none. */
function enclosingFunctionName(node: ts.Node, _source: ts.SourceFile): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const name = functionName(current);
      if (name) return name;
    }
  }
  return "<anonymous>";
}

/** Walk `root`, collecting every shape the analysis needs. */
function collect(root: ts.Node, source: ts.SourceFile, analysis: Analysis): void {
  const record = (map: Map<string, number[]>, receiver: string, offset: number) => {
    const offsets = map.get(receiver) ?? [];
    offsets.push(offset);
    map.set(receiver, offsets);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const listenReceiver = receiverText(node, "listen");
      const first = node.arguments[0];
      if (listenReceiver !== undefined && first !== undefined) {
        const value = unwrap(first);
        if (ts.isNumericLiteral(value) && value.text === "0") {
          record(analysis.bindZero, listenReceiver, node.getStart(source));
        } else {
          analysis.bindArguments.push({ expression: value, offset: node.getStart(source) });
        }
      }
      const closeReceiver = receiverText(node, "close");
      if (closeReceiver !== undefined) {
        record(analysis.close, closeReceiver, node.getStart(source));
      }
      const addressCaller = receiverText(node, "address");
      if (addressCaller !== undefined) analysis.address.add(addressCaller);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const fromAddress = addressReceiver(initializer);
      if (fromAddress !== undefined) {
        analysis.addressNameSource.set(node.name.text, fromAddress);
      } else {
        const fromPort = directPortReceiver(initializer);
        if (fromPort !== undefined) analysis.portNameSource.set(node.name.text, fromPort);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const fromAddress = addressReceiver(node.initializer);
      if (fromAddress !== undefined) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (ts.isIdentifier(property) && property.text === "port" && ts.isIdentifier(element.name)) {
            analysis.portNameSource.set(element.name.text, fromAddress);
          }
        }
      }
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const owner = enclosingFunctionName(node, source);
      const value = unwrap(node.expression);
      if (
        (ts.isIdentifier(value) && analysis.portNameSource.has(value.text)) ||
        directPortReceiver(value) !== undefined ||
        (ts.isPropertyAccessExpression(value) &&
          ts.isIdentifier(value.expression) &&
          analysis.addressNameSource.has(value.expression.text) &&
          value.name.text === "port")
      ) {
        const source =
          ts.isIdentifier(value)
            ? analysis.portNameSource.get(value.text)
            : directPortReceiver(value) ??
              analysis.addressNameSource.get((value as ts.PropertyAccessExpression).expression.getText(source));
        if (source !== undefined) analysis.functionSource.set(owner, source);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** True when `expression` holds the port of a server in `analysis`. */
function portReceiverOf(expression: ts.Expression, analysis: Analysis): string | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return analysis.portNameSource.get(value.text);
  if (ts.isCallExpression(value)) {
    const name = callName(value);
    if (name !== undefined) return analysis.functionSource.get(name);
  }
  const direct = directPortReceiver(value);
  if (direct !== undefined) return direct;
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.name.text === "port") {
    return analysis.addressNameSource.get(value.expression.text);
  }
  return undefined;
}

/**
 * Every pick-then-bind port helper in `source`: a server binds port 0, its
 * port is read from `address()`, the server is closed, and that port is used
 * by a later `listen` — whatever the function or variable is called, and with
 * no type annotation required.
 */
export function analyzeSource(source: string, name: string): PortFinding[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analysis: Analysis = {
    bindZero: new Map(),
    close: new Map(),
    address: new Set(),
    portNameSource: new Map(),
    addressNameSource: new Map(),
    functionSource: new Map(),
    bindArguments: [],
  };
  collect(file, file, analysis);

  // Propagate `const picked = pickPort()` and function returns a bounded number
  // of times: a helper may hand a port to another helper before a bind uses it.
  for (let pass = 0; pass < MAX_PROPAGATION_PASSES; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!analysis.portNameSource.has(node.name.text)) {
          const from = portReceiverOf(node.initializer, analysis);
          if (from !== undefined) {
            analysis.portNameSource.set(node.name.text, from);
            changed = true;
          }
        }
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const owner = enclosingFunctionName(node, file);
        if (!analysis.functionSource.has(owner)) {
          const from = portReceiverOf(node.expression, analysis);
          if (from !== undefined) {
            analysis.functionSource.set(owner, from);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!changed) break;
  }

  const findings: PortFinding[] = [];
  for (const [receiver, bindOffsets] of analysis.bindZero) {
    if (!analysis.address.has(receiver)) continue;
    const closeOffsets = analysis.close.get(receiver) ?? [];
    if (closeOffsets.length === 0) continue;
    const lastClose = Math.max(...closeOffsets);
    for (const bind of analysis.bindArguments) {
      if (bind.offset <= lastClose) continue;
      // The bind argument must name a port taken from THIS server.
      const portSource = portReceiverOf(bind.expression, analysis);
      if (portSource !== receiver) continue;
      for (const offset of bindOffsets) {
        const line = file.getLineAndCharacterOfPosition(offset).line + 1;
        const finding = { file: name, name: enclosingFunctionName(nodeAt(file, offset), file), line };
        if (!findings.some((seen) => seen.file === finding.file && seen.name === finding.name && seen.line === finding.line)) {
          findings.push(finding);
        }
      }
      break;
    }
  }
  return findings;
}

function nodeAt(source: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = source;
  const visit = (node: ts.Node) => {
    if (offset < node.getStart(source) || offset >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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

const NAMED_PICK_PORT = `
  import net from "node:net";
  async function pickPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
  const later = net.createServer();
  later.listen(await pickPort());`;

const UNTYPED_ALLOCATE_SOCKET = `
  import net from "node:net";
  const allocateSocket = async () => {
    const socket = net.createServer();
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
    const port = (socket.address()).port;
    await new Promise((resolve) => socket.close(() => resolve()));
    return port;
  };
  const later = net.createServer();
  later.listen(await allocateSocket());`;

const INLINE_ANONYMOUS = `
  import net from "node:net";
  function start() {
    const server = net.createServer();
    const boot = () => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => {
          const later = net.createServer();
          later.listen(port);
        });
      });
    };
    boot();
  }`;

describe("port helper guard (cli#1025)", () => {
  test("no cli test file picks a port and binds it later", () => {
    const offenders = testTreeSources(join(CLI_ROOT, "test"))
      .flatMap((file) => analyzeSource(readFileSync(file, "utf8"), relative(CLI_ROOT, file)));
    expect(offenders).toEqual([]);
  });

  test("reports a named, annotated pickPort copy", () => {
    expect(analyzeSource(NAMED_PICK_PORT, "pick-port.test.ts")).toEqual([
      { file: "pick-port.test.ts", name: "pickPort", line: 5 },
    ]);
  });

  test("reports an untyped allocateSocket copy", () => {
    expect(analyzeSource(UNTYPED_ALLOCATE_SOCKET, "allocate-socket.test.ts")).toEqual([
      { file: "allocate-socket.test.ts", name: "allocateSocket", line: 5 },
    ]);
  });

  test("reports an inline anonymous block", () => {
    expect(analyzeSource(INLINE_ANONYMOUS, "inline.test.ts")).toEqual([
      { file: "inline.test.ts", name: "boot", line: 6 },
    ]);
  });

  test("clears a listener that stays open", () => {
    const holds = `
      import net from "node:net";
      function holdPort() {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as net.AddressInfo).port;
          return port;
        });
      }`;
    expect(analyzeSource(holds, "holds.test.ts")).toEqual([]);
  });
});
