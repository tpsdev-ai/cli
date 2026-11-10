- **The release-age workflow guard follows workflow-invoked scripts and local composite actions; it refuses an install it cannot bind in followed shell scripts and composite actions.**

  Installs inside followed JavaScript or TypeScript scripts are not inspected; a computed script path is refused unless it is on the reviewed allowlist.
