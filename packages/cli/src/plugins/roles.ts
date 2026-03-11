import { registerHook } from "./hooks.js";

export interface RoleConfig {
  role: string;
  reviewStyle?: "security" | "architecture" | "general";
  reviewRules?: string[];
  ackAfterReview?: boolean;
  autoAssign?: boolean;
}

export function applyRole(config: RoleConfig, agentId: string): void {
  switch (config.role) {
    case "reviewer": {
      registerHook("mail.received", {
        name: `${agentId}-review-filter`,
        priority: 10,
        fn: async (_ctx) => {
          return { filtered: false };
        },
      });
      break;
    }
    case "implementer": {
      registerHook("task.after", {
        name: `${agentId}-task-cleanup`,
        priority: 90,
        fn: async (_ctx) => {
          return {};
        },
      });
      break;
    }
    case "strategist":
    case "coordinator":
    default:
      break;
  }
}
