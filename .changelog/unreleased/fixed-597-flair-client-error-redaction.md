- **The Flair client builds its errors only from safe, client-constructed context (Closes #597).**

  Flair client errors contain only the entry point, the method, the encoded
  request path the request was sent with (path parameters such as agent ids
  included, as on the wire), the HTTP status, and an error code drawn from a
  fixed allow-list of the Flair error codes this client can receive; any other
  value becomes `unrecognized_error`. Response bodies and transport messages are
  never included. Untrusted text is left out, never sanitised into an error: a
  transport failure is named by a fixed reason class derived from the error's
  `code`, and a successful response whose body is not JSON throws a safe error.
