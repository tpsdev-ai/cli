// cli#577 green fixture: process.env through a cast is still process.env.
(process as any).env.KEY = "x";
