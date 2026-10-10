// cli#577 red fixture: a non-mock value patched onto a member of a module
// object bound by a dynamic import. Not named *.test.ts, so no suite discovers it.
const m = await import("./direct-module-target.js");
m.target.method = () => "not-a-mock";
