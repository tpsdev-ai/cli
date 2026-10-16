- **`tps agent create` completes registration when Flair's row for the agent is `pending`.**
  It sends the generated key through `POST /AgentKeyRegister` over its operator
  credential and reads the stored key back: success is printed only when the key
  reads back equal. Each refusal from the endpoint exits non-zero with the agent,
  the Flair URL, the refusal name and a remedy; a Flair that does not serve the
  route (404 or 405) exits non-zero and names the minimum Flair version that does.
  Flair's `Agent` PUT and PATCH do not store `publicKey`, so neither is used.
