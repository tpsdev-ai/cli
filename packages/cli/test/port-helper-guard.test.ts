/**
 * cli#1025 — no test may choose a port by binding port 0, closing that
 * listener, and using the number for a bind later: another process can take
 * the port in between. This scan follows these forms, by the shape of the code
 * rather than a helper's name or type annotation, so a renamed or untyped copy
 * and an inline anonymous block are found too. A Promise resolver is followed
 * from the executor's first parameter, whatever that parameter is called:
 *
 * - `listen(0)` → `address().port` → `close` → that port in a later `listen`
 *   (directly, through a variable, or through a helper's return value);
 * - a function that binds 0, reads the port, closes the server and hands the
 *   port out, by `return` or by calling its Promise resolver, whether or not
 *   anything in the file consumes it.
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
  /** The functions that closed each receiver. */
  closeOwners: Map<string, Set<string>>;
  /** The parameter index a function closes, for `closeServer(server)`-style calls. */
  closers: Map<string, number>;
  /** A server variable destructured out of a helper's returned bundle. */
  serverAlias: Map<string, string>;
  address: Set<string>;
  portNameSource: Map<string, string>;
  addressNameSource: Map<string, string>;
  functionSource: Map<string, string>;
  /** A helper that hands out `{ server, port }` rather than the number alone. */
  functionBundleSource: Map<string, string>;
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

const sourceAliases = new WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Symbol>>();
const sourceCheckers = new WeakMap<ts.SourceFile, ts.TypeChecker>();

function bindingKey(identifier: ts.Identifier): string {
  const checker = sourceCheckers.get(identifier.getSourceFile());
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker?.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker?.getSymbolAtLocation(identifier);
  const binding = symbol && (sourceAliases.get(identifier.getSourceFile())?.get(symbol) ?? symbol);
  const declaration = binding?.valueDeclaration ?? binding?.declarations?.[0];
  return declaration ? `${binding!.name}@${declaration.getStart()}` : identifier.text;
}

function receiverKey(expression: ts.Expression): string {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return bindingKey(value);
  if (ts.isPropertyAccessExpression(value)) return `${receiverKey(value.expression)}.${value.name.text}`;
  return value.getText();
}

function functionKey(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return bindingKey(node.name);
  }
  const parent = node.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) {
    return bindingKey(parent.name);
  }
  return undefined;
}

function enclosingFunctionKey(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const key = functionKey(current);
      if (key) return key;
    }
  }
  return "<anonymous>";
}

function callName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return bindingKey(callee);
  if (ts.isPropertyAccessExpression(callee)) return bindingKey(callee.name);
  return undefined;
}

/** The binding key of the receiver of `receiver.method(...)`, if it has that shape. */
function receiverText(call: ts.CallExpression, method: string): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (call.expression.name.text !== method) return undefined;
  return receiverKey(call.expression.expression);
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

/** The binding keys a pattern introduces. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [bindingKey(name)];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...bindingNames(element.name));
  }
  return names;
}

/** True when `node` is the executor of `new Promise(...)`. */
function isPromiseExecutor(node: ts.FunctionLikeDeclaration): boolean {
  const parent = node.parent;
  return (
    ts.isNewExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "Promise" &&
    parent.arguments?.[0] === node
  );
}

/**
 * True when `call` calls the first parameter of an enclosing Promise executor:
 * the resolver's binding, not its spelling.
 */
function promiseResolverCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return false;
  const name = bindingKey(callee);
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      if (isPromiseExecutor(current)) {
        const first = current.parameters[0];
        if (first && bindingNames(first.name).includes(name)) return true;
      }
      // A parameter of an inner function shadows the outer resolver.
      for (const parameter of current.parameters) {
        if (bindingNames(parameter.name).includes(name)) return false;
      }
    }
  }
  return false;
}

/** The server whose port a helper hands out in a returned `{ server, port }` bundle. */
function portBundleReceiver(expression: ts.Expression, analysis: Analysis): string | undefined {
  const value = unwrap(expression);
  if (!ts.isObjectLiteralExpression(value)) return undefined;
  for (const property of value.properties) {
    if (ts.isPropertyAssignment(property)) {
      const from = portReceiverOf(property.initializer, analysis) ?? directPortReceiver(property.initializer);
      if (from !== undefined) return from;
    } else if (ts.isShorthandPropertyAssignment(property)) {
      const from = analysis.portNameSource.get(bindingKey(property.name));
      if (from !== undefined) return from;
    }
  }
  return undefined;
}

/** The first server whose port `expression` reads, at any depth, e.g. a `map`. */
function portReadIn(expression: ts.Expression, analysis: Analysis): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (found !== undefined) return;
    if (ts.isExpression(node)) {
      found = directPortReceiver(node) ?? portReceiverOf(node, analysis);
      if (found !== undefined) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
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
        const owner = enclosingFunctionKey(node);
        const owners = analysis.closeOwners.get(closeReceiver) ?? new Set<string>();
        owners.add(owner);
        analysis.closeOwners.set(closeReceiver, owners);
        // A function that closes its own parameter closes whatever server is
        // passed to it, so `closeServer(server)` counts as closing `server`.
        for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
          if (!ts.isFunctionLike(current)) continue;
          const index = current.parameters.findIndex(
            (parameter) => ts.isIdentifier(parameter.name) && bindingKey(parameter.name) === closeReceiver,
          );
          if (index >= 0) {
            const name = functionKey(current);
            if (name !== undefined) analysis.closers.set(name, index);
            break;
          }
        }
      }
      const called = callName(node);
      const closesThroughCall = called === undefined ? undefined : analysis.closers.get(called);
      if (closesThroughCall !== undefined && node.arguments.length > closesThroughCall) {
        const argument = unwrap(node.arguments[closesThroughCall]!);
        if (ts.isIdentifier(argument)) {
          const receiver = analysis.serverAlias.get(bindingKey(argument)) ?? bindingKey(argument);
          record(analysis.close, receiver, node.getStart(source));
          const owner = enclosingFunctionKey(node);
          const owners = analysis.closeOwners.get(receiver) ?? new Set<string>();
          owners.add(owner);
          analysis.closeOwners.set(receiver, owners);
        }
      }
      const addressCaller = receiverText(node, "address");
      if (addressCaller !== undefined) analysis.address.add(addressCaller);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const fromAddress = addressReceiver(initializer);
      if (fromAddress !== undefined) {
        analysis.addressNameSource.set(bindingKey(node.name), fromAddress);
      } else {
        const fromPort = directPortReceiver(initializer);
        if (fromPort !== undefined) {
          analysis.portNameSource.set(bindingKey(node.name), fromPort);
        } else if (
          ts.isPropertyAccessExpression(initializer) &&
          initializer.name.text === "port" &&
          ts.isIdentifier(initializer.expression)
        ) {
          const fromAddressName = analysis.addressNameSource.get(bindingKey(initializer.expression));
          if (fromAddressName !== undefined) analysis.portNameSource.set(bindingKey(node.name), fromAddressName);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const fromAddress = addressReceiver(node.initializer);
      if (fromAddress !== undefined) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (ts.isIdentifier(property) && property.text === "port" && ts.isIdentifier(element.name)) {
            analysis.portNameSource.set(bindingKey(element.name), fromAddress);
          }
        }
      }
      const initializer = unwrap(node.initializer);
      const name = ts.isCallExpression(initializer) ? callName(initializer) : undefined;
      const bundle = name === undefined ? undefined : analysis.functionBundleSource.get(name);
      if (bundle !== undefined) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (!ts.isIdentifier(property) || !ts.isIdentifier(element.name)) continue;
          if (property.text === "port") analysis.portNameSource.set(bindingKey(element.name), bundle);
          if (property.text === "server") analysis.serverAlias.set(bindingKey(element.name), bundle);
        }
      }
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const owner = enclosingFunctionKey(node);
      const value = unwrap(node.expression);
      const promiseExpression =
        ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "Promise";
      const origin = portReceiverOf(node.expression, analysis) ?? (promiseExpression ? undefined : portReadIn(node.expression, analysis));
      if (origin !== undefined) analysis.functionSource.set(owner, origin);
      const bundle = portBundleReceiver(node.expression, analysis);
      if (bundle !== undefined) analysis.functionBundleSource.set(owner, bundle);
    }
    // A Promise resolver's argument hands the port out as a return does. The
    // call is matched to the executor's first parameter, not to the name
    // `resolve`. A bundle keeps its server open, so it is tracked separately.
    if (ts.isCallExpression(node) && promiseResolverCall(node) && node.arguments.length === 1) {
      const owner = enclosingFunctionKey(node);
      const bundle = portBundleReceiver(node.arguments[0]!, analysis);
      if (bundle !== undefined) {
        analysis.functionBundleSource.set(owner, bundle);
      } else {
        const origin = portReceiverOf(node.arguments[0]!, analysis);
        if (origin !== undefined) analysis.functionSource.set(owner, origin);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** True when `expression` holds the port of a server in `analysis`. */
function portReceiverOf(expression: ts.Expression, analysis: Analysis): string | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return analysis.portNameSource.get(bindingKey(value));
  if (ts.isCallExpression(value)) {
    const name = callName(value);
    if (name !== undefined) return analysis.functionSource.get(name);
  }
  const direct = directPortReceiver(value);
  if (direct !== undefined) return direct;
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.name.text === "port") {
    return analysis.addressNameSource.get(bindingKey(value.expression));
  }
  return undefined;
}

/**
 * Every pick-then-bind port helper in `source`: a server binds port 0, its
 * port is read from `address()`, the server is closed, and the port is either
 * used by a later `listen` in the same file or handed out by a returning or
 * resolving helper. A resolver is found from the Promise executor's first
 * parameter, so its name does not matter. The function or variable is followed
 * by shape too, with no type annotation required. The forms it follows are
 * listed at the top of this file; it is not a claim to parse every way a port
 * can travel.
 */
export function analyzeSource(source: string, name: string): PortFinding[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analysis: Analysis = {
    bindZero: new Map(),
    close: new Map(),
    closeOwners: new Map(),
    closers: new Map(),
    serverAlias: new Map(),
    address: new Set(),
    portNameSource: new Map(),
    addressNameSource: new Map(),
    functionSource: new Map(),
    functionBundleSource: new Map(),
    bindArguments: [],
  };
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (fileName) => fileName === name ? file : undefined;
  const program = ts.createProgram([name], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  sourceCheckers.set(file, checker);
  const aliases = new Map<ts.Symbol, ts.Symbol>();
  sourceAliases.set(file, aliases);
  const elements = new Map<ts.Symbol, ts.Symbol>();
  const scanPushes = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "push") {
      const array = checker.getSymbolAtLocation(node.expression.expression);
      const first = node.arguments[0];
      const element = first && checker.getSymbolAtLocation(first);
      if (array && element) elements.set(array, element);
    }
    ts.forEachChild(node, scanPushes);
  };
  scanPushes(file);
  // Array callbacks read and close elements pushed into that array.
  const scanMaps = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
      const array = checker.getSymbolAtLocation(node.expression.expression);
      const element = array && elements.get(array);
      const callback = node.arguments[0];
      if (element && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const first = callback.parameters[0];
        const parameter = first && checker.getSymbolAtLocation(first.name);
        if (parameter) aliases.set(parameter, element);
      }
    }
    ts.forEachChild(node, scanMaps);
  };
  scanMaps(file);
  collect(file, file, analysis);

  // Propagate `const picked = pickPort()` and function returns a bounded number
  // of times: a helper may hand a port to another helper before a bind uses it.
  for (let pass = 0; pass < MAX_PROPAGATION_PASSES; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!analysis.portNameSource.has(bindingKey(node.name))) {
          const from = portReceiverOf(node.initializer, analysis);
          if (from !== undefined) {
            analysis.portNameSource.set(bindingKey(node.name), from);
            changed = true;
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        const initializer = unwrap(node.initializer);
        const name = ts.isCallExpression(initializer) ? callName(initializer) : undefined;
        const bundle = name === undefined ? undefined : analysis.functionBundleSource.get(name);
        if (bundle !== undefined) {
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name;
            if (!ts.isIdentifier(property) || !ts.isIdentifier(element.name)) continue;
            if (property.text === "port" && !analysis.portNameSource.has(bindingKey(element.name))) {
              analysis.portNameSource.set(bindingKey(element.name), bundle);
              changed = true;
            }
            if (property.text === "server" && !analysis.serverAlias.has(bindingKey(element.name))) {
              analysis.serverAlias.set(bindingKey(element.name), bundle);
              changed = true;
            }
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const called = callName(node);
        const index = called === undefined ? undefined : analysis.closers.get(called);
        if (index !== undefined && node.arguments.length > index) {
          const argument = unwrap(node.arguments[index]!);
          if (ts.isIdentifier(argument)) {
            const receiver = analysis.serverAlias.get(bindingKey(argument)) ?? bindingKey(argument);
            const owners = analysis.closeOwners.get(receiver) ?? new Set<string>();
            owners.add(enclosingFunctionKey(node));
            analysis.closeOwners.set(receiver, owners);
            const offsets = analysis.close.get(receiver) ?? [];
            const offset = node.getStart(file);
            if (!offsets.includes(offset)) {
              offsets.push(offset);
              analysis.close.set(receiver, offsets);
              changed = true;
            }
          }
        }
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const owner = enclosingFunctionKey(node);
        const value = unwrap(node.expression);
        const promiseExpression =
          ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "Promise";
        const origin = portReceiverOf(node.expression, analysis) ?? (promiseExpression ? undefined : portReadIn(node.expression, analysis));
        if (origin !== undefined && !analysis.functionSource.has(owner)) {
          analysis.functionSource.set(owner, origin);
          changed = true;
        }
        const bundle = portBundleReceiver(node.expression, analysis);
        if (bundle !== undefined && !analysis.functionBundleSource.has(owner)) {
          analysis.functionBundleSource.set(owner, bundle);
          changed = true;
        }
      }
      if (ts.isCallExpression(node) && promiseResolverCall(node) && node.arguments.length === 1) {
        const owner = enclosingFunctionKey(node);
        const bundle = portBundleReceiver(node.arguments[0]!, analysis);
        if (bundle !== undefined) {
          if (!analysis.functionBundleSource.has(owner)) {
            analysis.functionBundleSource.set(owner, bundle);
            changed = true;
          }
        } else {
          const origin = portReceiverOf(node.arguments[0]!, analysis);
          if (origin !== undefined && !analysis.functionSource.has(owner)) {
            analysis.functionSource.set(owner, origin);
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
    for (const bind of analysis.bindArguments) {
      // The bind argument must name a port taken from THIS server.
      const portSource = portReceiverOf(bind.expression, analysis);
      if (portSource !== receiver) continue;
      for (const offset of bindOffsets) {
        if (!closeOffsets.some((close) => offset < close && close < bind.offset)) continue;
        const line = file.getLineAndCharacterOfPosition(offset).line + 1;
        const finding = { file: name, name: enclosingFunctionName(nodeAt(file, offset), file), line };
        if (!findings.some((seen) => seen.file === finding.file && seen.name === finding.name && seen.line === finding.line)) {
          findings.push(finding);
        }
      }
    }
  }

  // A function that binds 0, reads the port, closes the server and hands the
  // port out — by `return` or by calling its Promise resolver — is the
  // pick-then-bind helper on its own, whatever consumes the number. The bind
  // may sit in a helper this one delegates to (`const { server, port } =
  // await pickBundle(); await closeServer(server); return port`).
  for (const [owner, receiver] of analysis.functionSource) {
    if (!analysis.address.has(receiver)) continue;
    if (!(analysis.closeOwners.get(receiver) ?? new Set<string>()).has(owner)) continue;
    for (const offset of analysis.bindZero.get(receiver) ?? []) {
      const line = file.getLineAndCharacterOfPosition(offset).line + 1;
      const finding = { file: name, name: owner.replace(/@\d+$/, ""), line };
      if (!findings.some((seen) => seen.file === finding.file && seen.name === finding.name && seen.line === finding.line)) {
        findings.push(finding);
      }
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

/** Every `.ts` source file under the cli test tree, except fixtures and the shared helper; `.mjs` files are skipped. */
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

const CALLBACK_PICK_PORT = `
  import net from "node:net";
  async function pickPort(): Promise<number> {
    return new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  }
  const later = net.createServer();
  later.listen(await pickPort());`;

const CALLBACK_PICK_PORT_UNCONSUMED = `
  import net from "node:net";
  async function pickPort(): Promise<number> {
    return new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  }`;

const RESOLVE_PORT_PICKER = `
  import net from "node:net";
  async function pickPort(): Promise<number> {
    const net = await import("node:net");
    return new Promise((resolvePort, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("no address")));
          return;
        }
        server.close(() => resolvePort(address.port));
      });
    });
  }
  const later = net.createServer();
  later.listen(await pickPort());`;

const RETURN_ADDRESS_PORT = `
  import net from "node:net";
  function pickPort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {});
    const address = server.address() as net.AddressInfo;
    server.close();
    return address.port;
  }`;

interface ReplayEntry {
  id: string;
  kind: "function" | "inline";
  name: string;
  file: string;
  lines: string;
  fixture: string;
  consumer: string;
}

/** The port helpers this diff removed, copied verbatim from origin/main. */
const REPLAY_DIR = join(TEST_ROOT, "fixtures", "port-helper-replay");
const REPLAY: { entries: ReplayEntry[] } = JSON.parse(readFileSync(join(REPLAY_DIR, "manifest.json"), "utf8"));

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

  test("reports a pickPort that hands the port out through a Promise resolver", () => {
    expect(analyzeSource(CALLBACK_PICK_PORT, "callback-pick-port.test.ts")).toEqual([
      { file: "callback-pick-port.test.ts", name: "pickPort", line: 6 },
    ]);
  });

  test("reports a Promise-resolving helper with no consumer in the file", () => {
    expect(analyzeSource(CALLBACK_PICK_PORT_UNCONSUMED, "callback-unconsumed.test.ts")).toEqual([
      { file: "callback-unconsumed.test.ts", name: "pickPort", line: 6 },
    ]);
  });

  test("reports the same helper when the Promise resolver is renamed", () => {
    expect(analyzeSource(RESOLVE_PORT_PICKER, "resolve-port.test.ts")).toEqual([
      { file: "resolve-port.test.ts", name: "pickPort", line: 8 },
    ]);
  });

  test("reports a helper that returns address.port without crashing", () => {
    expect(analyzeSource(RETURN_ADDRESS_PORT, "return-address-port.test.ts")).toEqual([
      { file: "return-address-port.test.ts", name: "pickPort", line: 5 },
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

  test("keeps unrelated port and server bindings separate", () => {
    const source = `
      function probePort() {
        const probe = net.createServer();
        probe.listen(0);
        const port = probe.address().port;
        probe.close();
      }
      function configuredPort() {
        const port = 45000;
        later.listen(port);
      }`;
    expect(analyzeSource(source, "separate-bindings.test.ts")).toEqual([]);
    const separateServers = `
      function probePort() {
        const probe = net.createServer();
        probe.listen(0);
        const port = probe.address().port;
        probe.close();
      }
      function configuredPort() {
        const probe = net.createServer();
        probe.listen(45000);
        const port = probe.address().port;
        probe.close();
        return port;
      }`;
    expect(analyzeSource(separateServers, "separate-servers.test.ts")).toEqual([]);
    const shadowed = `
      function start() {
        const probe = net.createServer();
        probe.listen(0);
        const port = probe.address().port;
        probe.close();
        {
          const port = 45000;
          later.listen(port);
        }
        later.listen(port);
      }`;
    expect(analyzeSource(shadowed, "shadowed-bindings.test.ts")).toEqual([
      { file: "shadowed-bindings.test.ts", name: "start", line: 4 },
    ]);
  });

  test("reports a rebind before repeated cleanup", () => {
    const source = `
      function start() {
        const probe = net.createServer();
        probe.listen(0);
        const port = probe.address().port;
        try {
          probe.close();
          later.listen(port);
        } finally {
          probe.close();
        }
      }`;
    expect(analyzeSource(source, "repeated-cleanup.test.ts")).toEqual([
      { file: "repeated-cleanup.test.ts", name: "start", line: 4 },
    ]);
    expect(analyzeSource(source.replace("probe.close();", ""), "late-cleanup.test.ts")).toEqual([]);
  });

  test("reports a rebind after the close when an earlier bind of the same port precedes it", () => {
    const source = `
      function start() {
        const probe = net.createServer();
        probe.listen(0);
        const port = probe.address().port;
        contender.listen(port);
        probe.close();
        later.listen(port);
      }`;
    expect(analyzeSource(source, "earlier-bind.test.ts")).toEqual([
      { file: "earlier-bind.test.ts", name: "start", line: 4 },
    ]);
  });

  test("reports a rebind after repeated calls to a later close helper", () => {
    const source = `
      async function start() {
        const probe = net.createServer();
        probe.listen(45000);
        await closeServer(probe);
        probe.listen(0);
        const port = probe.address().port;
        await closeServer(probe);
        later.listen(port);
      }
      async function closeServer(server) {
        await new Promise((resolve) => server.close(resolve));
      }`;
    expect(analyzeSource(source, "later-close-helper.test.ts")).toEqual([
      { file: "later-close-helper.test.ts", name: "start", line: 6 },
    ]);
  });

  test("replays every port helper this diff removed, with and without a consumer", () => {
    const functions = REPLAY.entries.filter((entry) => entry.kind === "function");
    const inline = REPLAY.entries.filter((entry) => entry.kind === "inline");
    expect(functions).toHaveLength(19);
    expect(functions.filter((entry) => entry.name === "freePort")).toHaveLength(18);
    expect(functions.filter((entry) => entry.name === "freePorts")).toHaveLength(1);
    expect(inline).toHaveLength(2);
    for (const entry of REPLAY.entries) {
      const source = readFileSync(join(REPLAY_DIR, entry.fixture), "utf8");
      for (const withConsumer of [false, true]) {
        const findings = analyzeSource(withConsumer ? `${source}\n${entry.consumer}` : source, entry.file);
        if (!findings.some((finding) => finding.name === entry.name)) {
          throw new Error(`${entry.id} ${withConsumer ? "with" : "without"} a consumer: ${JSON.stringify(findings)}`);
        }
      }
    }
  });
});
