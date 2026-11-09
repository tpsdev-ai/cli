- **The Docker image workflow smokes every platform it publishes against its own nono hash (Closes #353).**

  The nono builder base is pinned by digest, so a red smoke means a changed
  binary rather than a moving tag. Dispatching with `publish=false` runs the
  builds and smokes without pushing anything.
