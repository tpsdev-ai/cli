// cli#603 red fixture: a name destructured out of a guarded global root is a
// copy of that root, so a member write on it must go through patchShared.
// Not named *.test.ts, so no suite discovers it.
const { process } = globalThis;
process.exit = (() => {}) as never;
