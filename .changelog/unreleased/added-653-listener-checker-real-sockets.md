- **The real-Flair lane's listener checker is tested against sockets the tests bind.**
  Each case runs through the checker's no-argument entry and through `lsof` and
  `ss` where the platform has them, so a wildcard, mixed or absent listener is refused.
