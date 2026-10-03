- **Validate launcher grants before creating selected-runtime directories (Closes #483).**

  Pass approved canonical paths to nono; refuse TPS credential-root overlaps
  and foreign runtime credential files, with explicit file exceptions.
