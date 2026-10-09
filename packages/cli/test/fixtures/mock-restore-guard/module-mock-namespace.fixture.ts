import * as bt from "bun:test";

bt.afterEach(() => bt.mock.restore());
bt.mock.module("./some-module.js", () => ({ value: "mocked" }));
