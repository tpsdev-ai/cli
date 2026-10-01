- **The Docker Image workflow is dispatched with a version and refuses one npm
  has not published.** It ran on the Release workflow's completion, while the
  packages were still staged, so the image build's `npm install` failed with
  ETARGET. It now runs only when dispatched with a version, and it pushes the
  image only after the version has the required shape, npm has published it,
  and the image builds and passes its smoke checks. `:latest` is pushed only
  when the version equals npm's `latest` when the tags are computed. An npm
  version lookup that cannot verify publication, or a failed latest lookup,
  stops the run with "could not verify".

  Slice 1 of #420 changes `.github/workflows/docker.yml` and adds
  `.github/scripts/docker-image-tags.sh`; dispatching the workflow from the
  promote step is slice 2.
