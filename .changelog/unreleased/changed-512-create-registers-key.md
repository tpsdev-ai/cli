- **`tps agent create` registers a `pending` agent's key through Flair's `POST
  /AgentKeyRegister` when the route accepts it and the stored key reads back
  equal.** It sends the generated key through that route over its operator
  credential and reads the stored key back; the Flair registration line is
  printed only when Flair serves and accepts the route and the key reads back
  equal. Each refusal from the endpoint exits non-zero with the agent, the Flair
  URL, the refusal name and a remedy; a response this client cannot recognize as
  that endpoint's refusal (404 or 405) exits non-zero naming the minimum Flair
  version that serves the route as the likely cause; and a transport failure, a
  success body that is not JSON, or a `registration_unavailable` is answered by
  that read-back: `create` reports success only when the key reads back equal,
  and otherwise reports this attempt unconfirmed with the observed state. Flair
  drops `publicKey` on `Agent` PUT and PATCH: an existing row whose stored key
  differs still gets an `Agent` PUT carrying the key, which cannot store it.
