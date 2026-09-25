- **CI jobs now run with read-only tokens: the workflow grants nothing by default, each job declares only the scope its steps use, and every checkout leaves no token in `.git/config`.**

  (Refs tpsdev-ai/cli#412)
