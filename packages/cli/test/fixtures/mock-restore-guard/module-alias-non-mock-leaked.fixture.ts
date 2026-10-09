// cli#577 red fixture: a non-mock value patched onto a member of an imported
// module object read through a property alias. The value tracker does not apply
// (the value is not a mock) and the alias hides the module object; the guard
// decides by the target, so it must report direct-assignment-needs-restore. Not
// named *.test.ts, so no suite discovers it.
import * as mod from "./direct-module-target.js";

const target = mod.target;
target.method = () => "not-a-mock";
