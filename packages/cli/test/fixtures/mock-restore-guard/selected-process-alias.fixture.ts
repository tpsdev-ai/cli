const { process: p } = globalThis;
const { env } = p;
env.KEY = "x";
const { KEY: value } = p.env;
value.method = () => "changed";
p.exit = () => {};
