- **Flair client errors contain only the entry point, method and path, status, and a short server error code when present; response bodies and transport messages are never included (Closes #597).**

  The client no longer builds an error from a response body or a transport
  failure's message. A server that echoes the request's credential back — whole,
  as a fragment, as an encoding, or as a signature component — cannot put it into
  the thrown error, a formatted log line, or a `cause`: exact-value redaction
  cannot catch a fragment, so the error names only safe, client-constructed
  context. A transport failure is named by a fixed reason class derived from the
  error's code, and a successful response whose body is not JSON throws a safe
  error.
