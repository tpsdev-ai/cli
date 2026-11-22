// start-token-proc-preload.mjs — TEST-ONLY (cli#1045). Preload with
// `node --import <file URL>` or `bun --preload <path>`: every live pid gets a
// `proc:` start token in the process, the same one the test process stages.
import { installForPreload } from "./start-token-source.mjs";

installForPreload("proc");
