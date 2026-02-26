import type { Tool } from "./registry.js";
import type { MailClient } from "../io/mail.js";
import type { ToolResult } from "../runtime/types.js";

interface MailArgs {
  to: string;
  body: string;
}

export function makeMailTool(mail: MailClient): Tool {
  return {
    name: "mail",
    description: "Send mail to another agent or manager.\nInput: {\"to\": string, \"body\": string}",
    input_schema: {
      to: { type: "string", description: "Recipient" },
      body: { type: "string", description: "Message body" },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const payload = (args as unknown) as unknown as MailArgs;
      if (typeof payload.to !== "string" || typeof payload.body !== "string") {
        return { content: "mail tool requires to and body", isError: true };
      }

      await mail.sendMail(payload.to, payload.body);
      return { content: `Sent mail to ${payload.to}`, isError: false };
    },
  };
}
