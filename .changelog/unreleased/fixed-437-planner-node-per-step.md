- **After resolution selects the current image, the reviewer launcher refuses a `default` step in a plan with a Node pin (`node-mismatch`; Closes #437).**

  A planned `run:` step carries `node`: `default`, or the version the most
  recent preceding `setup-node` pins. Conflicting in-matrix pins are refused as
  `conflicting`; a different selected image as `wrong-image`.
