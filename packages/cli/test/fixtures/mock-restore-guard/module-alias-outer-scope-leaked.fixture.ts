// cli#603 red fixture: an alias of an imported module object declared in an
// outer scope is still that module object inside an inner scope, so the write
// must report direct-assignment-needs-restore.
// Not named *.test.ts, so no suite discovers it.
import * as mod from "./direct-module-target.js";

const alias = mod;

function inner() {
  alias.method = () => "not-a-mock";
}
