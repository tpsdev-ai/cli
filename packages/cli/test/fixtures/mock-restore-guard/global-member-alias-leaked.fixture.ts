// cli#577 red fixture: a local named like a guarded global is bound to that
// global through a property read, so it is an alias and not a shadow. The
// right-hand side is not a mock; the guard decides by the target. Not named
// *.test.ts, so no suite discovers it.
const process = globalThis.process;
process.exit = () => {};

const D = globalThis["Date"];
D.now = () => 0;
