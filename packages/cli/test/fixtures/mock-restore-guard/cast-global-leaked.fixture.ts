import { afterEach, mock } from "bun:test";
afterEach(() => mock.restore());
(globalThis as any).x = mock(() => {});
