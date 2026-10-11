- **A Flair error carries only the entry point, method, requested pathname, status and an allow-listed code; raw bodies are never included (Closes #597).**

  A non-OK Flair response error contains only the entry point, the method, the
  requested path the request was sent with (path parameters such as agent ids
  included and encoded, as on the wire; never the query or fragment), the HTTP
  status, and an error code from the allow-list of codes the routes and verbs
  this client sends can return; any other value becomes `unrecognized_error`. An
  allow-listed code is selected from the response's `error` field; raw bodies,
  other response text and transport messages are never included. The client's
  wrapper methods encode their ids; `request()` sends the path its caller
  supplies, so a direct caller encodes an id it builds a path from. Transport
  failures, malformed-response errors and local errors have their own fixed,
  body-free formats — a transport failure is named by a fixed reason class
  derived from the error's `code`, a non-JSON 2xx body names `malformed response
  body`, and a local error names the entry point.
