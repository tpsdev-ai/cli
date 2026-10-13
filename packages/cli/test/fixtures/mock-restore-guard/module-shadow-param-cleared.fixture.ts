// cli#603 green fixture: a local that shadows an imported module object's name
// is not that module object, so a non-mock write on it is not a patch.
// Not named *.test.ts, so no suite discovers it.
import * as mod from "./direct-module-target.js";

function local(mod: { method(): string }) {
  mod.method = () => "not-a-mock";
}
