- **`scripts/promote-latest.sh` dispatches the Docker image build after `latest` has moved (Closes #420).**

  After a successful move, the script runs `gh workflow run docker.yml --repo
  tpsdev-ai/cli -f version=<version>`. A dispatch that fails leaves the promote
  in place and exits 6; `--no-docker` skips the dispatch.
