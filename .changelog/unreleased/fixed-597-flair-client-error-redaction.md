- **The Flair client redacts the request's credential from error messages built from a response body or a transport failure (Closes #597).**

  A server that echoes the request's credential back in a response body no
  longer puts it into a thrown error message; a transport failure's message is
  redacted the same way.
