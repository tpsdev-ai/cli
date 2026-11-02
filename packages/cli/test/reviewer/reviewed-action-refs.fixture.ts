/**
 * reviewed-action-refs.fixture.ts — the reviewed SHA-to-tag pairs for the
 * skipped actions in scripts/reviewer/ci-job.mjs, resolved independently of
 * that allowlist from each action's own repository with:
 *
 *   git ls-remote https://github.com/<owner>/<repo> \
 *     'refs/tags/<tag>' 'refs/tags/<tag>^{}'
 *
 * The peeled ref is the commit an annotated tag names. Each pair below was
 * recorded on 2026-11-02; every tag resolved to a lightweight tag, so the
 * commit is the tag's own ref.
 */
export const REVIEWED_ACTION_REFS: Record<string, Record<string, string>> = {
  "actions/checkout": {
    "11bd71901bbe5b1630ceea73d27597364c9af683": "v4.2.2",
    "34e114876b0b11c390a56381ad16ebd13914f8d5": "v4.3.1",
    "11d5960a326750d5838078e36cf38b85af677262": "v4.4.0",
  },
  "oven-sh/setup-bun": {
    "735343b667d3e6f658f44d0eca948eb6282f2b76": "v2.0.2",
    "0c5077e51419868618aeaa5fe8019c62421857d6": "v2.2.0",
  },
  "actions/setup-node": {
    "49933ea5288caeca8642d1e84afbd3f7d6820020": "v4.4.0",
  },
  "socketdev/action": {
    "ba6de6cc0565af1f42295590380973573297e31f": "v1.3.2",
  },
  "actions/cache": {
    "55cc8345863c7cc4c66a329aec7e433d2d1c52a9": "v6.1.0",
    "1bd1e32a3bdc45362d1e726936510720a7c30a57": "v4.2.0",
    "0057852bfaa89a56745cba8c7296529d2fc39830": "v4.3.0",
  },
  "actions/upload-artifact": {
    "ea165f8d65b6e75b540449e92b4886f43607fa02": "v4.6.2",
  },
};
