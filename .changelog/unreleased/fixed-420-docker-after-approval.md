- **The Docker Image workflow is dispatched with a version and refuses one npm
  has not published.** It ran on the Release workflow's completion, while the
  packages were still staged, so npm answered ETARGET and the Docker run failed;
  the image is now built when the workflow is dispatched with the version, which
  must be public on npm first, and `:latest` moves only when that version is
  npm's `latest`.

  Slice 1 of #420 changes `.github/workflows/docker.yml`; dispatching the
  workflow from the promote step is slice 2.
