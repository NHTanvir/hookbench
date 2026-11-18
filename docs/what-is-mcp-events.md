# What is MCP Events (SEP-3415)?

**MCP Events is an extension of the Model Context Protocol (MCP) that lets an MCP server tell a client when something happens in an upstream system. A new email, a push to a repository or a production incident can then wake an AI agent without a user asking.** It is defined by SEP-3415 and identified as `io.modelcontextprotocol/events`. It offers three delivery modes: poll (`events/poll`), push (`events/stream`) and signed webhooks (`events/subscribe`). The MCP Core Maintainers voted SEP-3415 Accepted on 2026-11-11, and it is defined for protocol revision `2026-07-28` and later.

To try it on your machine, run `npx github:NHTanvir/hookbench demo` ([Hookbench](../README.md)).

## Why does MCP need events?

MCP is request-driven: a user or a model asks and a server answers. The notifications MCP already had cannot say "a P1 incident was created for service X":

- **They carry no parameters or payload.** `notifications/resources/updated` says only that a URI changed.
- **They need a live connection.** A client that is not connected receives nothing.
- **They cannot be resumed.** Events that happen during a disconnect are lost silently.

MCP Events adds the missing pieces: typed event types with subscription arguments and a payload schema, delivery to clients that are offline or behind NAT, and cursors to resume from.

## How does a server advertise MCP Events?

In the result of `server/discover`, under the `extensions` field of its capabilities:

```json
{
  "capabilities": {
    "extensions": {
      "io.modelcontextprotocol/events": { "listChanged": true }
    }
  }
}
```

`listChanged` (default `false`) says whether the server sends `notifications/events/list_changed`. A client MUST NOT send `events/*` to a server that has not advertised the extension. A server without it answers `events/*` with `-32601` (Method not found).

Prototypes of the earlier design sketch used a top-level `capabilities.events` key. ChatGPT and the Vercel AI SDK still read that key (see [ChatGPT's dialect](#how-does-chatgpts-mcp-events-differ-from-sep-3415)).

## What does `events/list` return?

A page of event types, each describing what can be watched and what will be delivered:

```json
{
  "resultType": "complete",
  "events": [
    {
      "name": "incident.created",
      "description": "Fires when a new PagerDuty incident is created",
      "delivery": ["webhook", "push", "poll"],
      "inputSchema": {
        "type": "object",
        "properties": { "severity": { "type": "string", "enum": ["P1", "P2", "P3", "P4"] } }
      },
      "payloadSchema": { "type": "object", "properties": { "incidentId": { "type": "string" } } }
    }
  ],
  "nextCursor": "page-2"
}
```

- `delivery` is any non-empty subset of `poll`, `push` and `webhook`. No mode is mandatory.
- `inputSchema` describes the subscription `arguments`: filters, transforms or other settings. A property MAY carry `x-mcp-header` to mirror its value into an `Mcp-Param-*` HTTP header.
- `payloadSchema` describes `data` in every delivered event.

Schemas SHOULD evolve additively. A breaking change ships under a new event name.

## What is an EventOccurrence?

The unit every delivery mode carries:

| Field | Required | Meaning |
| --- | --- | --- |
| `eventId` | yes | the server's id for the upstream event, ideally the upstream's own (a Stripe `evt_…`, a GitHub delivery GUID); used for deduplication within a subscription |
| `name` | yes | the event type |
| `timestamp` | yes | ISO 8601 time the event happened |
| `data` | yes | an object that matches `payloadSchema` |
| `cursor` | no | the subscription's position after this event (push and webhook); `null` when the type has no replay |
| `_meta` | no | protocol metadata, outside `payloadSchema` |

## How do the three delivery modes work?

| | Poll | Push | Webhook |
| --- | --- | --- | --- |
| Start | first `events/poll` with `cursor: null` | an `events/stream` request | `events/subscribe` with a callback URL and secret |
| Delivery | in the poll result | `notifications/events/event` on the stream | a signed HTTP POST to the callback |
| Keep alive | keep polling every `nextPollMs` | server heartbeats; reconnect with the cursor | call `events/subscribe` again before `refreshBefore` |
| Stop | stop polling | close or cancel the stream | `events/unsubscribe`, or let the TTL lapse |
| Server state | none | for the life of the request | a TTL-scoped subscription |
| Best for | serverless servers, clients behind NAT | local agents, stdio servers | remote servers, clients that are offline |

### Poll: `events/poll`

```json
{ "name": "email.received", "arguments": { "from": "*@example.com" }, "cursor": null, "maxEvents": 50 }
```

```json
{ "resultType": "complete", "events": [], "cursor": "historyId_99842", "truncated": false, "hasMore": false, "nextPollMs": 30000 }
```

`cursor: null` means "start from now": no past events, just a fresh cursor. When `hasMore` is true the client polls again at once. Otherwise it waits `nextPollMs`, with a floor of about 1000 ms so a misbehaving server cannot cause a tight loop.

### Push: `events/stream`

One long-lived request per subscription. Over Streamable HTTP the response is an SSE stream:

```json
{"jsonrpc":"2.0","method":"notifications/events/active","params":{"cursor":"c_1","truncated":false,"heartbeatMs":15000,"_meta":{"io.modelcontextprotocol/subscriptionId":1}}}
{"jsonrpc":"2.0","method":"notifications/events/event","params":{"eventId":"evt_001","name":"email.received","timestamp":"2026-02-19T15:30:00Z","data":{"subject":"MCP spec review"},"cursor":"c_2","_meta":{"io.modelcontextprotocol/subscriptionId":1}}}
{"jsonrpc":"2.0","method":"notifications/events/heartbeat","params":{"cursor":"c_2","_meta":{"io.modelcontextprotocol/subscriptionId":1}}}
```

The first message confirms the subscription and grants a heartbeat interval. Every notification carries the `events/stream` request id in `_meta["io.modelcontextprotocol/subscriptionId"]`. The server MUST send a heartbeat whenever `heartbeatMs` passes quietly, and a client that hears nothing for three intervals reconnects with its last cursor. Over HTTP, closing the stream cancels the subscription.

### Webhook: `events/subscribe`

```json
{
  "name": "incident.created",
  "arguments": { "severity": "P1" },
  "delivery": { "mode": "webhook", "url": "https://proxy.example.com/hooks/client123", "secret": "whsec_…" },
  "cursor": null,
  "ttlMs": 3600000
}
```

```json
{ "resultType": "complete", "id": "sub_a3f1c8e2b0d49f7e", "refreshBefore": "2026-02-19T16:30:00Z", "cursor": "cursor_start_001", "truncated": false }
```

The subscription is keyed by `(principal, delivery.url, name, arguments)`, so subscribing again with the same key refreshes it instead of creating a second one. The client suggests a lifetime with `ttlMs`. The server grants one in `refreshBefore`, which SHOULD be no longer than asked and is `null` only if the client asked for no expiry. The server then POSTs each event:

```text
POST https://proxy.example.com/hooks/client123
Content-Type: application/json
webhook-id: msg_2KWPBgLlAfxdpx2AI54pPJ85f4W
webhook-timestamp: 1739980800
webhook-signature: v1,<base64 HMAC-SHA256(secret, webhook-id + "." + webhook-timestamp + "." + body)>
X-MCP-Subscription-Id: sub_a3f1c8e2b0d49f7e

{"eventId":"evt_789","name":"incident.created","timestamp":"2026-02-19T16:00:00Z","data":{"incidentId":"INC-1234"},"cursor":"cursor_xyz"}
```

## How are MCP Events webhooks secured?

- **Signatures.** Deliveries follow [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md). The client supplies the secret: `whsec_` plus base64 of 24 to 64 random bytes. The HMAC key is the decoded bytes, and the MAC covers the raw body. Receivers MUST verify before processing, SHOULD reject timestamps more than 5 minutes old, and SHOULD deduplicate on `webhook-id`.
- **`webhook-id` identifies the message, not the event.** It is random, reused across retries of the same message, and MUST NOT be derived from `eventId`.
- **Endpoint verification.** Before the first delivery, the server proves the endpoint wants deliveries. Usually it POSTs a signed `{"type":"verification","challenge":"<nonce>"}`, which the endpoint echoes as `{"challenge":"<nonce>"}`. The other options are an allowlist, out-of-band registration, or the receiver publishing `/.well-known/mcp-webhook-receiver.json`.
- **TLS and SSRF.** Callback URLs MUST be `https`. Servers SHOULD refuse private and loopback addresses, MUST re-check the address at delivery time, and MUST NOT follow redirects.
- **Authentication.** `events/subscribe` and `events/unsubscribe` need an authenticated principal (`Forbidden` otherwise). Unauthenticated servers may offer poll and push only.
- **Retries.** A non-`2xx` response is retried with exponential backoff, bounded (for example 3 to 5 attempts over 10 to 15 minutes). `410` and `413` are never retried.

## How do cursors and replay work?

A cursor is an opaque position the server hands out and the client stores. Poll results, push heartbeats and webhook refresh responses all carry it, so it advances even when nothing happens. `cursor: null` in a request means "start from now". A type with no history returns `cursor: null`, and replay simply is not available for it.

`maxAgeMs` bounds replay. `truncated: true` is the one signal that events were skipped: on a poll result, on a fresh `notifications/events/active`, or as a `{"type":"gap"}` webhook envelope.

## What error codes does MCP Events use?

| Name | Code | When |
| --- | --- | --- |
| `InvalidParams` | -32602 | arguments break `inputSchema`, a non-`https` callback, or a bad `whsec_` secret |
| `NotFound` | -32023 | an unknown event name, or no subscription for the key on unsubscribe |
| `Forbidden` | -32024 | the principal is not allowed, or its access was revoked |
| `ResourceExhausted` | -32025 | a limit or quota was hit |
| `Unsupported` | -32026 | a delivery mode or option the event type does not offer |
| `CallbackEndpointError` | -32027 | the callback failed verification or could not be reached (`data.reason`) |

The numbers are provisional until the SEP is merged. Design-sketch code from before 2026-10-08 used `-32011` to `-32015`.

## What happens when access is revoked?

The server ends the subscription with the same nested `error` in every mode:
- `notifications/events/terminated` on a push stream
- a JSON-RPC error on the next `events/poll`
- a signed `{"type":"terminated","error":{…}}` webhook

`NotFound` or `Unsupported` means "re-list and resubscribe", and `Forbidden` means "stop". Receiving an event never authorizes an action: the agent's response goes through normal MCP authorization.

## Who supports MCP Events today?

As of 2026-11-18, **no official MCP SDK** ships MCP Events. The TypeScript SDK has no Events code, and the Python SDK has an open pull request.

| Runtime | Side | Delivery | Status |
| --- | --- | --- | --- |
| ChatGPT | client | webhook | shipping since OpenAI DevDay (2026-09-29) |
| Vercel AI SDK (`@ai-sdk/mcp`) | client | webhook | experimental |
| TanStack AI (`@tanstack/ai-mcp`) | client | webhook | experimental |
| Mastra (`@mastra/mcp`) | client and server | poll, push, webhook | experimental |
| `mcp-handler` (Vercel Labs) | server | webhook | released |
| Claude | client | none | not yet supported |

Sources and versions are in [RESEARCH.md](RESEARCH.md#runtime-support-2026-11-18).

## How does ChatGPT's MCP Events differ from SEP-3415?

OpenAI's [ChatGPT guide](https://developers.openai.com/plugins/build/mcp-events) describes a dialect:

| | SEP-3415 | ChatGPT |
| --- | --- | --- |
| Capability | `capabilities.extensions["io.modelcontextprotocol/events"]` | top-level `capabilities.events` |
| `webhook-id` | random, MUST NOT come from `eventId` | equals `eventId` |
| `CallbackEndpointError` | `-32027` | `-32015` |
| Modes | poll, push, webhook | webhook only, no `gap` or `terminated` |

The Vercel AI SDK and TanStack AI also reject deliveries whose `webhook-id` differs from `eventId`. A server today has to pick a side, or advertise both capability keys and follow its main consumer's `webhook-id` rule. Hookbench tests either side with `--profile sep-3415` or `--profile chatgpt`.

## How do I test MCP Events?

With [Hookbench](../README.md):
- `hookbench connect <mcp-url>` is a mock consumer for your server.
- `hookbench fire` emits a test event.
- `hookbench check <mcp-url>` grades 35 conformance rules.
- `hookbench serve` is a reference server for testing clients.

The official conformance suite for SEP-3415 is in review as [modelcontextprotocol/conformance#521](https://github.com/modelcontextprotocol/conformance/pull/521).

## FAQ

### Is MCP Events part of the MCP specification?

Not yet. It is an extension defined by an Accepted SEP (2026-11-11). It becomes Final once an official SDK ships a reference implementation and the SEP is merged.

### What is the difference between MCP Events and webhooks?

Webhooks are one of MCP Events' three delivery modes. MCP Events adds what plain webhooks lack:
- discovery of what can be watched (`events/list`) and typed arguments and payloads
- subscriptions the client controls, with a TTL
- cursors for replay
- a single subscription model that also works over poll and push

### What is the difference between MCP Events and MCP Tasks?

Tasks (`io.modelcontextprotocol/tasks`) track a long-running operation that a client started. Events report things that happen on their own, upstream. Both now belong to the same working group, the Tasks and Events WG.

### Who maintains MCP Events?

The MCP Tasks and Events Working Group: Clare Liguori (AWS), Peter Alexander, Luca Chang (AWS) and Caitie McCaffrey (Microsoft). Peter Alexander wrote SEP-3415. Incubation happens in [modelcontextprotocol/ext-events](https://github.com/modelcontextprotocol/ext-events).

## Timeline

| Date | What happened |
| --- | --- |
| 2026-02-19 | Design sketch "MCP Events" by Peter Alexander |
| 2026-03-24 | Triggers and Events Working Group chartered |
| 2026-07-28 | MCP protocol revision 2026-07-28: stateless requests, `server/discover`, extensions |
| 2026-09-29 | OpenAI DevDay: ChatGPT adds support for the proposed MCP Events specification |
| 2026-10-05 | SEP-3415 opened |
| 2026-10-16 | The working group becomes the Tasks and Events WG |
| 2026-11-11 | SEP-3415 Accepted by the Core Maintainers |

## Sources

- [SEP-3415: Events Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) (PR head `60b15c1`, read 2026-11-18)
- [Design sketch](https://github.com/modelcontextprotocol/ext-events/blob/main/docs/design-sketch-proposal.md)
- [Tasks and Events WG charter](https://modelcontextprotocol.io/community/triggers-events/charter)
- [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [OpenAI: MCP Events in ChatGPT](https://developers.openai.com/plugins/build/mcp-events) and the [DevDay 2026 recap](https://openai.com/index/devday-2026-recap/)
- [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
