// cli#587 green fixture: `g` names the globalThis binding only until the
// assignment rebinds it to a local value. The member assignment after the
// rebinding is on the local, so no patch is required. Not named *.test.ts, so no
// suite discovers it.
const local = { fetch: () => "local" };
let g = globalThis;
g = local;
g.fetch = () => "after";
