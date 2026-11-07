- **The release-age gate checks every tracked npm lockfile CI installs from (Closes #797).**
  Each registry-fetched `node_modules` entry is aged as the package its `resolved`
  tarball URL identifies, with the same exceptions and exit codes as `bun.lock`.
  A URL that disagrees with the recorded name or version, or a `git:`/`git+...`
  entry, is refused naming the lockfile and entry. A test refuses a workflow
  `npm ci` step it cannot trace to a tracked lockfile.
