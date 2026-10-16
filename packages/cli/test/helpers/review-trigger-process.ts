import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = process.env.HOME!;
const command = basename(process.argv[1]!);
const args = process.argv.slice(2);
const changed = join(root, "model-commit");
const input = command === "git" ? "" : readFileSync(0, "utf8");
appendFileSync(join(root, "processes.jsonl"), JSON.stringify({ command, args, input }) + "\n");
if (command === "codex") {
  writeFileSync(changed, "changed");
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Implemented change" } }));
} else if (command === "gh-as") {
  if (args[1] === "pr" && args[2] === "create") console.log("https://github.com/example/repo/pull/17");
  else if (args[1] !== "api") process.exit(1);
} else if (command === "git") {
  switch (args[0]) {
    case "rev-parse":
      if (args.includes("--is-inside-work-tree")) process.exit(1);
      console.log(existsSync(changed) ? "model-head" : "baseline-head");
      break;
    case "symbolic-ref": console.log(args.includes("--short") ? "origin/main" : "refs/heads/main"); break;
    case "rev-list": console.log("1"); break;
    case "rebase": process.exit(1); break;
    case "status": case "checkout": case "fetch": case "reset": case "clean": case "push": break;
    default: process.exit(1);
  }
} else process.exit(1);
