// cli#603 green fixture: a local that shadows a module-object alias's name is
// not that alias, so a non-mock write on it is not a patch.
// Not named *.test.ts, so no suite discovers it.
import * as mod from "./direct-module-target.js";

const alias = mod;

function inner(alias: { method(): string }) {
  alias.method = () => "not-a-mock";
}
