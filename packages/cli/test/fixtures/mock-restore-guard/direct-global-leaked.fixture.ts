// cli#568 red fixture: a direct assignment to a global the runtime preload does
// not snapshot (guarded-globals.ts), outside the patchShared helper. The guard
// must report direct-assignment-needs-restore. The name ends in .fixture.ts,
// not .test.ts, so no suite discovers it.
globalThis.__tpsGuardProbe = () => "mock";
