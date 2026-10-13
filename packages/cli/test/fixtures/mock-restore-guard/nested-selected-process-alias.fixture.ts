const { process: { env } } = globalThis;
env.KEY = "x";
const { globalThis: { process: p } } = globalThis;
const { env: environment } = p;
environment.KEY = "x";
p.exit = () => {};
