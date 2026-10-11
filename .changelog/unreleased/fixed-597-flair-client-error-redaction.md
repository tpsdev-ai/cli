- **The Flair client builds its errors only from safe, client-constructed context (Closes #597).**

  Flair client errors contain only the entry point, method and path, status, and
  a short server error code when present; response bodies and transport messages
  are never included. Untrusted text is left out, never sanitised into an error,
  so a server response or a transport failure cannot introduce request detail: a
  transport failure is named by a fixed reason class derived from the error's
  code, and a successful response whose body is not JSON throws a safe error.
