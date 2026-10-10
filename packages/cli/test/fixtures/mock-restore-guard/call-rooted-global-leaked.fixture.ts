// cli#577 red fixture: a non-mock value assigned to a member of a call result.
// The root cannot be resolved, so the scan reports it whatever the value. Not
// named *.test.ts, so no suite discovers it.
declare function getG(): typeof globalThis;

getG().fetch = () => 0;
