- **A guard now fails CI if the test workflow's least privilege slips: a job that declares no `permissions` block of its own, a `write` scope with no comment naming the step that needs it, a checkout that keeps its token, or a top level that grants anything.**

  `packages/cli/test/workflow-permissions.test.ts` reads
  `.github/workflows/test.yml` and holds the shape cli#415 gave it: the top
  level grants nothing, every job declares its own block, every `write` sits
  beside a comment naming the step that uses it, and every `actions/checkout`
  sets `persist-credentials: false`. It also pins the set of workflows that run
  PR-controlled code, so a new one cannot appear without a decision recorded
  there. Every failure names the job or step responsible.

  (Refs #416)