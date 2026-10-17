- **`tps agent create` registers a `pending` agent's key through Flair's `POST
  /AgentKeyRegister` when the route accepts it and the stored key reads back
  equal.** It sends the generated key through that route over its operator
  credential. Definitive refusals exit non-zero with the agent, the Flair URL,
  the refusal name and a remedy; an error response with no recognized refusal,
  or an unreadable error body, remains unconfirmed with its HTTP status; an
  unrecognized 404 or 405 names the minimum Flair
  version that serves the route as the likely cause. After a successful or
  ambiguous POST, a read-back that fails or does not return the generated key
  reports this attempt unconfirmed with a re-run-create remedy. Flair
  drops `publicKey` on `Agent` PUT and PATCH.
