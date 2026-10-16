- **`tps agent create` completes registration when Flair's row for the agent is `pending`.**
  It sends the generated key through `POST /AgentKeyRegister` over its operator
  credential and reads the stored key back; the Flair registration line is
  printed only when the key reads back equal. Each refusal from the endpoint
  exits non-zero with the agent, the Flair URL, the refusal name and a remedy; a
  response this client cannot recognize as that endpoint's refusal (404 or 405)
  exits non-zero naming the minimum Flair version that serves the route as the
  likely cause. Flair drops `publicKey` on `Agent` PUT and PATCH: an existing row
  whose stored key differs still gets an `Agent` PUT carrying the key, which
  stores nothing.
