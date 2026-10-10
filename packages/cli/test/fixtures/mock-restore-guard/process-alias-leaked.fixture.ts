// cli#577 red fixture: `p` aliases the guarded root process, so the assignment
// must report direct-assignment-needs-restore.
const p = process;
p.exit = (() => {}) as never;
