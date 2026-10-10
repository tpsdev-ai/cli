// cli#577 green fixture: each assignment resolves to a declaration in an
// enclosing function, block or catch scope, not to the global.
function f(process: { exit: unknown }) {
  {
    process.exit = 1;
  }
  return () => {
    process.exit = 2;
  };
}
{
  const console = { log: 0 };
  console.log = 1;
}
try {
  f({ exit: 0 });
} catch (globalThis: any) {
  globalThis.fetch = 3;
}
