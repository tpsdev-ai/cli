import { afterEach as a, mock as m } from "bun:test";

a(() => m.restore());
m.module("./some-module.js", () => ({ value: "mocked" }));
