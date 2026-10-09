import * as bt from "bun:test";

bt.afterEach(() => { bt.mock.restore(); });
bt.spyOn({ connect() {} }, "connect");
