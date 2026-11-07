- **The release-age gate checks every tracked npm lockfile CI installs from (Closes #797).**
  Each `node_modules` entry with a registry `resolved` URL is aged as the package
  that URL identifies, against the same minimum age and exception list as
  `bun.lock`. A URL that disagrees with the recorded name or version, or a
  `git:`/`git+...` entry, is refused naming the lockfile and entry. A test
  refuses a workflow `npm ci` step it cannot trace to a tracked lockfile.
