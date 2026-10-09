// cli#577 red fixture: the mock value reaches a guarded global through a value
// read from an object property, which the value tracker does not follow. The
// guard decides by the target (a guarded global), so it must report
// direct-assignment-needs-restore. Not named *.test.ts, so no suite discovers it.
import { afterEach, mock } from "bun:test";

afterEach(() => mock.restore());

const holder = { m: mock(() => {}) };
const m = holder.m;
setImmediate = m;
