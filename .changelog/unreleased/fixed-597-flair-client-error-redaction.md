- **Non-OK Flair response errors name the entry point, method, requested pathname, status and an allow-listed code (else `unrecognized_error`), without raw response bodies (Closes #597).**

  The client reads an allow-listed string from the response's `error` field
  when present; other values become `unrecognized_error`. The exported list is
  a frozen array; membership is module-private. Response error messages exclude
  raw bodies and other response text. The reported pathname excludes query and
  fragment; encoded parameters stay encoded when the wrapper or caller encodes
  them. Wrapper methods encode ids; `request()` sends its caller's path.
  Caught transport failures use `Flair <entry> <method> <pathname> transport
  error: <reason>`, without the original transport message. Failed
  successful-response JSON parses use `Flair <entry> <method> <pathname> →
  <status>: malformed response body`; `request()` and `registerAgent()` accept
  204 without parsing. Local checks interpolate ids (promotion refusals,
  invalid principal records, governance read refusals and missing agents);
  private-key read failures interpolate the key path and agent id. Governance
  read failures also embed the caught error's message. These local messages
  are outside the response bound.
