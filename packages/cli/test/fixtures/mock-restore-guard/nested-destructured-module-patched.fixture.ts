// cli#577 red fixture: a non-mock value patched onto an object reached through a
// nested destructuring of a module import. Not named *.test.ts, so no suite discovers it.
import * as mod from "./direct-module-target.js";
const { target: { nested } } = mod as any;
nested.method = () => 1;
