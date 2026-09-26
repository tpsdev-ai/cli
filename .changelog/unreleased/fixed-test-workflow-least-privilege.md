- **Each CI job now declares only the scope its steps use, no job inherits a token scope, and every checkout leaves no credentials in `.git/config`; the only write scope is the CodeQL job's SARIF upload.**

  (Refs tpsdev-ai/cli#412)
