- **The release-age gate checks every tracked npm lockfile CI installs from (Closes #797).**
  Each registry-resolved `node_modules` entry is checked against the same minimum
  age, exceptions and exit codes as `bun.lock`. A non-registry `resolved` URL is
  refused, naming the lockfile and entry, and a test fails when a workflow runs
  `npm ci` from a lockfile the gate does not read.
