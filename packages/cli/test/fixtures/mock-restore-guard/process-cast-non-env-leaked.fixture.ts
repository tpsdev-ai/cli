// cli#577 red fixture: a cast does not exempt a non-env member of process.
(process as any).exit = () => {};
