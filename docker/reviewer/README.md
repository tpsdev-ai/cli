# Reviewer sandbox image

The image a reviewer agent builds and tests a pull request inside. It carries the
repository's runtimes and a `gh` with **no credential of its own**: no token in
the image, its environment or the launcher's child environment, and no
configured credential helper or auth setting in the image or the mounted
worktree's git configuration. The GitHub review credential never enters it.
linux/amd64 only (the reviewer VMs are x86_64).

## What `review-build-ok` means

`review-build-ok` is **advisory evidence for the reviewer, not a merge gate**:
CI remains the gate on every PR. The boundary this image and launcher hold is
that no credential and no host access are reachable from the review. How well
a review build predicts CI is best effort: the launcher refuses workflow
features it cannot reproduce faithfully, and the fidelity limits that remain are
listed under [Known limits](#known-limits).

## Pieces

- `Dockerfile` — `FROM` debian:bookworm-slim pinned by digest, with OpenClaw's
  sandbox package set (bash, ca-certificates, curl, git, jq, python3, ripgrep)
  plus Node, Bun, a tokenless `gh` and the launcher's js-yaml, each at an exact
  version verified against a checksum from the trusted table. No entrypoint; the
  CMD is `sleep infinity`, because OpenClaw starts the sandbox as
  `<image> sleep infinity` without overriding the entrypoint.
- `runtime-matrix.json` — the **trusted** table: base digest and platform,
  per-tool exact versions and checksums, the launcher's js-yaml pin (the version
  and integrity `bun.lock` pins), and the image matrix. Maintained here and
  installed on the host; the reviewed checkout can neither extend it nor choose
  a download source.
- `bin/reviewer-launch` — the review build command, run explicitly inside the
  sandbox. Build mode takes no arguments (the worktree is always `/workspace`);
  the only other mode is `--self-check`. `shims/sfw` — stands in for Socket
  Firewall's `sfw` wrapper (runs the wrapped command unchanged; the firewall
  itself is not reproduced).
- `../../scripts/reviewer/reviewer-launch.mjs` — the trusted launcher. It reads
  the fixed table and the image's baked identity, and the host's assignment —
  `REVIEWER_CI_WORKFLOW`, `REVIEWER_CI_JOB`, `REVIEWER_CI_BASE` — from the
  environment the **host** gave the sandbox when it created it (the container
  init's, `/proc/1/environ`); a caller that passes different values is refused.
  That integrity is conditional: it holds only if the host denies same-user
  process-memory writes, which is not yet verified (tpsdev-ai/cli#436; see
  [Known limits](#known-limits)).
  It refuses symlinked lockfiles and symlinked directories in the worktree
  (outside `node_modules/` and `.git/`) before the build and again after every
  job, plans the job and the jobs it needs, resolves the declarations and pins
  to ONE image and refuses unless it is THIS image; builds the child env from an
  allowlist with a fixed `PATH`; and runs the image's own node and bun at fixed
  paths to verify their versions. Then, per job in dependency order, it removes
  what earlier jobs of the build created, gives the job a fresh
  `HOME`/`TMPDIR`/cache root, refuses a worktree whose effective git
  configuration leaves the safe baseline (below) or whose repository holds
  hooks, and refuses unless the worktree passes the clean-clone check
  (below). It runs every `run:` step as one script under `/bin/bash
  --noprofile --norc -eo pipefail`, after re-checking the step's effective
  environment and that its resolved working directory stays inside the
  worktree; it enforces `timeout-minutes` (the job's, default 360, and each
  planned `run:` step's; on a skipped `uses:` step it is refused) and kills
  what a job left running when the job ends.
  `review-build-ok` only if every job in the closure ran, every step exited 0,
  and no lockfile in the worktree (outside `node_modules/` and `.git/`)
  changed, appeared or disappeared.
- `../../scripts/reviewer/ci-job.mjs` — bounds the workflow (256 KiB, 50,000
  YAML nodes counting every alias use, 32 levels), parses it (YAML 1.2 core
  schema), requires printable-ASCII keys, and requires a `pull_request` trigger
  that covers the host-named base branch. It plans the named job and its
  `needs` closure. Every job must begin with `actions/checkout` and run on
  `ubuntu-latest` or `ubuntu-24.04` (the labels these repositories use; CI shows
  ubuntu-latest resolving to ubuntu-24.04). Skipped — each only at a reviewed
  commit SHA, only with every input the real action needs, and only with input
  values whose skip is equivalent: checkout (first step only; fetch-depth 1 or
  0), setup-bun and setup-node (an exact version, which becomes a verified pin),
  socketdev (firewall-free), cache (path and key required; a miss may not fail
  the job) and upload-artifact (path required; a missing file may not fail the
  job; a valid name unique in the workflow). Refused: any other action or ref;
  a `${{ }}` expression anywhere the launcher would have to evaluate it —
  scripts, env values, working directories, runner labels, timeouts and every
  input of a skipped action (a skipped action never evaluates it, so a value
  the real action would reject, such as a cache key with a comma, cannot be
  ruled out); the only expressions accepted are `if:` conditions that are
  exactly `success()` or `always()`. Also refused: `timeout-minutes` on a
  skipped `uses:` step, other `if:` conditions, `continue-on-error`,
  `strategy`, containers/services, non-bash shells, launcher-owned env keys,
  and credential-shaped or config-redirecting env such as `GH_TOKEN`,
  `*_TOKEN`, `GIT_*`, `NPM_CONFIG_*`, `NODE_OPTIONS`, `BASH_ENV`, `LD_*`.
- `../../scripts/reviewer/resolve-runtime.mjs` — resolves `packageManager`,
  `engines`, `.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions` and the
  jobs' pins to ONE matrix image with npm-semver range semantics, or refuses by
  name (`invalid-declaration`, `ambiguous`, `conflicting`, `out-of-matrix`). An
  out-of-matrix refusal names the missing image by its requirements, e.g.
  `missing image: node >=25 with bun 1.3.10`.
- `../../scripts/reviewer/build-reviewer-image.mjs` — builds one matrix image for
  linux/amd64 with every input read from the table; prints its local image id.
- `../../scripts/reviewer/image-checks.sh` — the image-level checks (A2, A3, A9),
  with the build-path fixtures run the way OpenClaw runs the sandbox.
  `../../scripts/reviewer/a9-red-proofs.sh` — requires the A9 checks to FAIL on
  derived images with planted fake credentials. Both run in the `reviewer-image`
  CI job.

### The git safe baseline

Before every job the launcher reads `git config --list --show-origin` as a step
would see it (system, a fresh global, the worktree's own config) and accepts
only what a plain `git clone` and an identity write: `core.repositoryformatversion`,
`core.filemode`, `core.bare`, `core.logallrefupdates`, `core.ignorecase`,
`core.precomposeunicode`, `core.symlinks`, `extensions.objectformat`,
`user.name`, `user.email`, `init.defaultbranch`,
`remote.<name>.{url,fetch,tagopt,promisor,partialclonefilter}` and
`branch.<name>.{remote,merge}`. A remote URL carrying credentials, naming a
transport helper (`<helper>::`) or starting with `-` is refused. Everything
else — `core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.editor`,
`core.sshCommand`, `core.askPass`, `protocol.*`, `uploadpack.*`,
`url.*.insteadOf`/`pushInsteadOf`, `credential.*`, `http.*`, `include*`,
`filter.*`, `diff.*`, `alias.*`, ... — is refused by key (never by value). A
repository `hooks/` directory may hold only git's `*.sample` files.

The baseline is an allowlist of **keys**. It does not approve the **values**
of `remote.<name>.url` and `remote.<name>.fetch`: those are whatever the host's
clone wrote, and the launcher trusts them as the host's choice. It pins them
before the first job and refuses any change before each later job (see below),
so a transport or refspec change made by the build itself is refused.

### The clean-clone check

`actions/checkout` is skipped only when, before each job, the worktree passes
these checks (and only these):

- a commit is checked out; for every job after the first, HEAD and every
  `remote.<name>.url` / `remote.<name>.fetch` value are what they were before
  the first job;
- no tracked file carries the assume-unchanged or skip-worktree index bit
  (`git ls-files -v`: a lowercase tag or `S`), since either hides an edit from
  `git status`;
- `git status`, with replace objects ignored, reports no modified, untracked or
  ignored path;
- history is shaped as `fetch-depth` asks: a shallow one-commit clone without
  tags for the default, a full clone for `fetch-depth: 0`.

It is not a byte-for-byte comparison with a host-pinned commit: a change `git
status` does not report (for example a line-ending-only change under a text
attribute) and state inside `.git/` beyond HEAD, the index bits and the remote
settings are not detected. Giving each job an independent tree at a
host-pinned commit is tracked in tpsdev-ai/cli#435.

## Building and installing on a reviewer host

```bash
node scripts/reviewer/build-reviewer-image.mjs reviewer-node22-bun1310
bash scripts/reviewer/image-checks.sh reviewer-image:reviewer-node22-bun1310 reviewer-node22-bun1310
```

There is no registry in this slice. The host builds the image from this pinned
Dockerfile at install time and records the printed `local_image_id`
(`sha256:…`) in its sandbox config (`sandbox.docker.image`), a content-addressed
reference the container engine itself resolves. The same config carries the
assignment: `sandbox.docker.env` sets `REVIEWER_CI_WORKFLOW`, `REVIEWER_CI_JOB`
and `REVIEWER_CI_BASE`, which the container runtime gives the sandbox's init
process at creation. The host mounts the review worktree as a fresh clone of
the assigned head with its git metadata inside it: depth 1 without tags for
workflows using checkout's default fetch, a full clone for `fetch-depth: 0`.

Builds on different hosts are **not** claimed to produce the same image id: the
base is digest-pinned and every runtime is checksum-verified, but the apt
packages are not version-pinned. Cross-host reproducibility is a follow-up.

## Known limits

Trust boundary (host integration, PR 3):

- The assignment is read from the container init's environment, which runs as
  the same user as the sandbox. Its integrity relies on the deployed sandbox
  denying same-user process-memory writes (no ptrace capability; Yama
  `ptrace_scope` ≥ 1). That is a host-integration check against the real run
  configuration, not something this image can prove, and it is not in place
  yet: until tpsdev-ai/cli#436 lands, "a caller cannot change the assignment"
  holds only against a caller that sets its own environment, not against one
  that can write the init process's memory.

CI fidelity (`review-build-ok` may disagree with CI):

- Jobs of a `needs` closure run one after another in the one worktree. Before
  each job the launcher removes what earlier jobs created and requires the
  clean-clone check above; it keeps a `node_modules/` that existed before the
  build whole (a fresh clone has none, so the first job's check refuses it).
  What that check cannot see carries over (tpsdev-ai/cli#435).
- On `pull_request`, CI checks out the merge of the head into the base; the
  review builds the assigned head.
- CI's runner image carries its own Node (e.g. 22.23.2 today) where a workflow
  does not pin one; the review uses the matrix image's (22.22.1).
- Socket Firewall is not reproduced (`sfw` runs the command unwrapped); cache
  restores never happen (a cold build); a workflow's artifact uploads are not
  performed.
- Each step runs with `pipefail`; CI's default for an unspecified shell is
  `bash -e {0}`.
- Only a `pull_request` trigger with exact branch names is evaluated; the
  assignment is static per reviewer, so a review into another base is refused.
- The "no credential" statements cover the image, the environments the launcher
  builds and the worktree's git configuration. They do not cover a credential
  that repository code itself supplies (committed, generated or fetched at
  build time).
- OpenClaw's default `/tmp` tmpfs is `noexec`, as measured in the reviewer-image
  CI run. A suite that executes files from `TMPDIR` needs `/tmp:exec` in the
  reviewer's sandbox config (A15).
