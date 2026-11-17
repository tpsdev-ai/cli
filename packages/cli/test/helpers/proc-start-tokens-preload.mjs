// proc-start-tokens-preload.mjs — test support for cli#1045.
//
// Loaded with `node --import <file URL> <tps.js> …` so a CLI subprocess reads
// the same `proc:` start tokens the test process stages with
// installProcStartTokens (see proc-start-tokens.mjs). Installed for the life of
// the subprocess.
import { installProcStartTokens } from "./proc-start-tokens.mjs";

installProcStartTokens();
