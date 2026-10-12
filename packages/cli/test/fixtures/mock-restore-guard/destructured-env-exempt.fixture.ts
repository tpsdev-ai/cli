// cli#603 green fixture: destructuring process.env yields the env-leak preload's
// object, which is not a guarded global, so a write on it is not a patch.
// Not named *.test.ts, so no suite discovers it.
const { env } = process;
env.KEY = "x";
