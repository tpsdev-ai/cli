import { runAuth } from "../../src/commands/auth.js";

await runAuth({ action: "login", provider: process.argv[2] });
