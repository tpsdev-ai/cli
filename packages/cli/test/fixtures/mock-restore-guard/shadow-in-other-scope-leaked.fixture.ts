// cli#577 red fixture: `process` is a parameter of one function only. The
// assignment in the other function resolves to the global, so it must report
// direct-assignment-needs-restore.
function shadowed(process: unknown) {
  return process;
}
function leaks() {
  process.exit = (() => {}) as never;
}
shadowed(leaks);
