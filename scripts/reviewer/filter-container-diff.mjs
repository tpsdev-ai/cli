// Print changes outside the worktree and ephemeral mounts. Docker's --init
// injection is harmless only when it is the sole change beneath /usr.
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
const lines = raw === "" ? [] : raw.split("\n");
if (lines.at(-1) === "") lines.pop();

const entries = lines.map((line) => ({ line, match: /^[ACD] (\/.*)$/.exec(line) }));
const initEntries = new Set(["C /usr", "C /usr/sbin", "A /usr/sbin/docker-init"]);
const usrEntries = entries.filter(({ match }) => match && /^\/usr(?:\/|$)/.test(match[1]));
const initOnly = usrEntries.some(({ line }) => line === "A /usr/sbin/docker-init")
  && usrEntries.every(({ line }) => initEntries.has(line));
const ephemeral = /^\/(?:workspace|tmp|var\/tmp|run|dev|proc|sys)(?:\/|$)/;
const dockerConfig = /^\/etc\/(?:hosts|hostname|resolv\.conf)$/;

for (const { line, match } of entries) {
  if (initOnly && initEntries.has(line)) continue;
  if (match && (ephemeral.test(match[1]) || dockerConfig.test(match[1]))) continue;
  process.stdout.write(`${line}\n`);
}
