- **`tps office kill` signals only a process whose recorded start token matches.** Host
  state records written by the relay now carry the token, and the branch pid file
  is read through the shared pid-file check. A live pid whose token is missing or
  different is not signalled: its record is kept and named, and the command exits
  non-zero.
