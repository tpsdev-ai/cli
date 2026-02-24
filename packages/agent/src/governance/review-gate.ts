import type { MailClient } from "../io/mail.js";

/** Actions that must pause for human-in-the-loop approval. */
const HIGH_RISK_ACTIONS = new Set([
  "git_push",
  "package_install",
  "file_delete",
  "exec_privileged",
]);

export class ReviewGate {
  constructor(
    private readonly mail: MailClient,
    private readonly approverAddress: string
  ) {}

  isHighRisk(toolName: string): boolean {
    return HIGH_RISK_ACTIONS.has(toolName);
  }

  async requestApproval(toolName: string, args: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(
      {
        type: "approval_request",
        tool: toolName,
        args,
        requestedAt: new Date().toISOString(),
      },
      null,
      2
    );
    await this.mail.sendMail(this.approverAddress, body);
  }
}
