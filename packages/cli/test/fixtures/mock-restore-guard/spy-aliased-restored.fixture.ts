import { afterEach as a, mock as m, spyOn as s } from "bun:test";

a(() => m.restore());
s({ connect() {} }, "connect");
