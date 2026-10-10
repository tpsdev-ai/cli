// cli#587 green fixture: the namespace import `mod` is shadowed by a parameter
// of the same name, so the member assignment targets the parameter, not the
// module object. The scan resolves the root by binding, so no patch is
// required. Not named *.test.ts, so no suite discovers it.
import * as mod from "./direct-module-target.js";

function use(mod: { method: () => string }) {
  mod.method = () => "local";
}
use({ method: () => "original" });
