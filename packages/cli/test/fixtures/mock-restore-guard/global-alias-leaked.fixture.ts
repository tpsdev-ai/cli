// cli#577 red fixture: `g` aliases the guarded root globalThis, so the
// assignment must report direct-assignment-needs-restore.
const g = globalThis;
g.fetch = (async () => new Response("")) as typeof fetch;
