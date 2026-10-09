import { afterEach, spyOn, mock } from "bun:test";
import * as ed from "@noble/ed25519";
afterEach(() => mock.restore());
const replacement = spyOn(ed.hashes, "sha512");
const alias = replacement;
ed.hashes.sha512 = alias;
