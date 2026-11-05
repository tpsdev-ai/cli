- **The branch daemon installs its SIGTERM and SIGINT handlers before it starts listening (Refs #744).**
  A stop signal sent as soon as the port opens now runs the daemon's shutdown
  path instead of the runtime's default handler.
