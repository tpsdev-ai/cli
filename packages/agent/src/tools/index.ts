import { BoundaryManager } from "../governance/boundary.js";
import { MailClient } from "../io/mail.js";
import { ToolRegistry } from "./registry.js";
import { makeReadTool } from "./read.js";
import { makeWriteTool } from "./write.js";
import { makeEditTool } from "./edit.js";
import { makeExecTool } from "./exec.js";
import { makeMailTool } from "./mail.js";

export { makeReadTool, makeWriteTool, makeEditTool, makeExecTool, makeMailTool };

export interface ToolSetOptions {
  boundary: BoundaryManager;
  mail: MailClient;
  tools?: Array<"read" | "write" | "edit" | "exec" | "mail">;
  execAllowlist?: string[];
}

export function createDefaultToolset({ boundary, mail, tools, execAllowlist }: ToolSetOptions): ToolRegistry {
  const registry = new ToolRegistry();
  const names: Array<"read" | "write" | "edit" | "exec" | "mail"> = tools ?? ["read", "write", "edit", "exec", "mail"];

  if (names.includes("read")) registry.register(makeReadTool(boundary));
  if (names.includes("write")) registry.register(makeWriteTool(boundary));
  if (names.includes("edit")) registry.register(makeEditTool(boundary));
  if (names.includes("exec")) registry.register(makeExecTool(boundary, execAllowlist));
  if (names.includes("mail")) registry.register(makeMailTool(mail));

  return registry;
}
