// cli#568 fixture target for direct-module-*.fixture.ts: an imported module
// object a test file may patch. The name ends in .ts, not .test.ts, so no suite
// discovers it.
export const target = {
  method(): string {
    return "original";
  },
};
