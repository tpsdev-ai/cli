- **Renovate's setup-action runtime rule matches by dependency name, and reviewer tests read workflow versions.** The github-actions `uses-with` rule now matches `depName`, so setup-node's `node` dependency (package `actions/node-versions`) is skipped; the trusted runtime matrix gains Node 24.22.0.

  Reviewer tests derive skipped-action tags and runtime pins from the workflow, and fail on an unallowlisted SHA.
