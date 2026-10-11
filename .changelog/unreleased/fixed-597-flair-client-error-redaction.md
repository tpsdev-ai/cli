- **The Flair client builds its errors only from safe, client-constructed context (Closes #597).**

  A non-OK Flair response error contains only the entry point, the method, the
  requested path the request was sent with (path parameters such as agent ids
  included and encoded, as on the wire; never the query or fragment), the HTTP
  status, and an error code from the allow-list of codes this client's routes can
  return; any other value becomes `unrecognized_error`. Raw response bodies,
  unlisted response text and transport messages are excluded: an allow-listed
  code is selected from the response's `error` field, and reported paths keep
  caller-supplied path parameters. Transport failures, malformed-response errors
  and local errors have their own fixed, body-free formats — a transport failure
  is named by a fixed reason class derived from the error's `code`, a non-JSON 2xx
  body names `malformed response body`, and a local error names the entry point.
