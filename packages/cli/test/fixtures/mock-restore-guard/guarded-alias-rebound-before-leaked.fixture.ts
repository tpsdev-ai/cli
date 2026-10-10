// cli#587 red fixture: the member assignment before the rebinding is on the
// guarded global, so it must report direct-assignment-needs-restore; the one
// after the rebinding is on a local and is not reported. Not named *.test.ts, so
// no suite discovers it.
const local = { fetch: () => "local" };
let g = globalThis;
g.fetch = () => "before";
g = local;
g.fetch = () => "after";
