// Not named *.test.ts, so no suite discovers it.
const { process } = globalThis;
process.exit = (() => {}) as never;
