- **Test stand-ins and fake supervisors exit with the process they watch.** A
  stand-in compares its owner's saved start token, so a reused pid, an owner
  that exited unreaped, or a probe that cannot verify the owner ends it; the
  fake supervisors that own a child wait for it and exit when it ends.
