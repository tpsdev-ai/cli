import { afterEach, mock } from "bun:test";
afterEach(() => mock.restore());
const x = {};
((x as any).m) = mock(() => {});
