import { afterEach, mock } from "bun:test";
afterEach(() => mock.restore());
fetch = mock(async () => new Response("fixture"));
