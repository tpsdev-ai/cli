// cli#577 green fixture: a local object that merely shares a guarded global's
// name. The scan resolves the root against the file's own bindings, so the
// local wins and no patch is required. Not named *.test.ts, so no suite
// discovers it.
const process = { exitCode: 0 };
process.exitCode = 1;
