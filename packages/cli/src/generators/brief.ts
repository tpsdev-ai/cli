import type { TPSReport } from "../schema/report.js";

/**
 * Generates the OPERATIONS.md brief that teaches an agent how to interact with the TPS environment.
 */
export function generateOperationalBrief(report: TPSReport, isBranch: boolean): string {
  const name = report.name || report.identity.default_name;
  
  return `# Operations Manual: ${name}

You are operating within the **Team Provisioning System (TPS)**. 
TPS is an Agent OS that enforces strict isolation boundaries. You do not share a context window with other agents. You must use the \`tps\` CLI to coordinate.

## 1. The Mailroom (Async Communication)
You communicate with your team via asynchronous mail.
- **Check your inbox**: \`tps mail check\` (run this periodically if you are waiting for a reply).
- **Send a message**: \`tps mail send <agent-id> "<message>"\`
- **Read history**: \`tps mail search <query>\`

## 2. The Roster (Finding Teammates)
You are not alone. To find out who else is on your team and what they do:
- **List all agents**: \`tps roster list\`
- **Look up an agent's skills**: \`tps roster show <agent-id>\`

## 3. Git Worktrees (Safe Collaboration)
When modifying code repositories, you must NEVER work directly in the main checkout if others are using it.
- **Create your isolated workspace**: \`tps git worktree ${name.toLowerCase()} <path-to-repo>\`
- Always perform your git operations (branching, committing, pushing) inside your dedicated worktree.

## 4. Security Boundaries
${isBranch ? "- You are running in a **Remote Branch Office**. You have local filesystem access within your workspace, but you must use the Mailroom to communicate with the host or other agents." : "- You are running under **nono** process isolation. Your filesystem access is restricted to your workspace, and your network access may be filtered."}

Stick to your role, use the CLI tools provided, and file your TPS reports.
`;
}
