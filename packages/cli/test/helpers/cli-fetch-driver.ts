import { readFileSync } from "node:fs";
import { startFetchFlair } from "./fetch-flair.js";
const values = JSON.parse(readFileSync(process.env.TEST_FLAIR_SEEDS!, "utf8"));
startFetchFlair(Object.fromEntries(Object.entries(values).map(([id, hex]) => [id, Buffer.from(hex as string, "hex")])));
await import("../../bin/tps.ts");
