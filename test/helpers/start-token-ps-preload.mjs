// start-token-ps-preload.mjs — TEST-ONLY (cli#1045). Preload with
// `bun --preload <path>` or `node --import <file URL>`: every `/proc/<pid>/stat`
// read in the process fails as absent, so processStartToken uses `ps`.
import { installForPreload } from "./start-token-source.mjs";

installForPreload("ps");
