- **The Docker test image installs from the committed lock.** The image copies the
  cli-<platform> manifests the lock lists as workspaces, so the frozen install
  succeeds and the unfrozen fallback is gone.
