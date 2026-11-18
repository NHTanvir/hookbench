# Research notes: MCP Events (SEP-3415)

Phase 0 notes for Hookbench. Everything the tool does is built from these notes, and every
claim below links to the source it came from. Read on **2026-11-18**. MCP Events is a draft
that is still moving, so where a source and this file disagree, the source wins.

## Sources

| What | Where | Version read |
| --- | --- | --- |
| SEP-3415: Events Extension (the normative text) | [modelcontextprotocol#3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), file `seps/3415-events-extension.md` | PR head `60b15c1`, PR updated 2026-11-17 |
| Design sketch the SEP was written from | [ext-events `docs/design-sketch-proposal.md`](https://github.com/modelcontextprotocol/ext-events/blob/main/docs/design-sketch-proposal.md) (the repo `experimental-ext-triggers-events` now redirects to `ext-events`) | `main` @ `47d95c9`, 2026-11-12; sketch dated 2026-02-19, error codes renumbered 2026-10-08 |
| Working group charter and work items | [Tasks and Events WG charter](https://modelcontextprotocol.io/community/triggers-events/charter) | fetched 2026-11-18 |
| Base protocol, revision `2026-07-28` | [modelcontextprotocol.io/specification/2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) and its source under `docs/specification/2026-07-28/` | released 2026-07-28 |
| Streamable HTTP transport | [basic/transports/streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) | 2026-07-28 |
| `server/discover` | [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) | 2026-07-28 |
| Versioning and extension negotiation | [basic/versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) | 2026-07-28 |
| Standard Webhooks (the signing scheme MCP webhooks profile) | [standard-webhooks.md](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) | `main`, fetched 2026-11-18 |
| OpenAI DevDay 2026 recap | [openai.com/index/devday-2026-recap](https://openai.com/index/devday-2026-recap/) | DevDay held 2026-09-29 ([event page](https://openai.com/index/devday-2026/)); the recap returned HTTP 403 to our fetcher, so its wording below comes from the search index quote |
| OpenAI's ChatGPT guide for MCP Events | [developers.openai.com/plugins/build/mcp-events](https://developers.openai.com/plugins/build/mcp-events) | fetched 2026-11-18, no date on the page |
| Official conformance suite, server side | [conformance#521](https://github.com/modelcontextprotocol/conformance/pull/521) (`src/seps/sep-3415.yaml`) | open, updated 2026-11-16 |
| Official conformance suite, client side | [conformance#541](https://github.com/modelcontextprotocol/conformance/pull/541) | open, updated 2026-11-09 |
| Support survey | [Hookdeck: What Are MCP Events and How Do They Work?](https://hookdeck.com/webhooks/guides/what-are-mcp-events) | "as of October 26, 2026" |
| Vercel AI SDK source | [vercel/ai `packages/mcp`](https://github.com/vercel/ai/tree/486e08f0446a/packages/mcp) | `main` @ `486e08f`, 2026-11-17; npm `@ai-sdk/mcp` 2.0.101 |
| TanStack AI source | [TanStack/ai `packages/ai-mcp`](https://github.com/TanStack/ai/tree/361b9e73b70a/packages/ai-mcp) | `main` @ `361b9e7`, 2026-11-17; npm `@tanstack/ai-mcp` 1.2.0 |

## Status, confirmed

- **The SEP number is SEP-3415**, as the brief guessed. SEP numbers are PR numbers in
  `modelcontextprotocol/modelcontextprotocol`; Peter Alexander (@pja-ant) opened PR 3415 on
  2026-10-05.
- **It is Accepted.** On 2026-11-11 a WG lead wrote: "The Core Maintainers voted on this SEP and
  it is now Accepted. We'll begin the work to finalise and get this merged." The PR carries the
  labels `SEP`, `accepted`, `extension`, `triggers-event-wg`. It is **not merged yet**.
- **Accepted is not Final.** On 2026-11-16 the SEP bot reminded the author that an accepted SEP
  needs a reference implementation in an official SDK to move to Final. The SEP's own Reference
  Implementation section says that implementation "is outstanding".
- **The working group was renamed.** It started as the Triggers and Events WG (charter dated
  2026-03-24) and became the **Tasks and Events Working Group** on 2026-10-16, when Tasks moved in.
  Leads: Clare Liguori (AWS), Peter Alexander (@poita), Luca Chang (AWS), Caitie McCaffrey
  (Microsoft).
- **The charter's work-item table is stale.** It still lists "SEP: Events in MCP v1 RFC" as
  *Ideating, target End April, champion TBD*, and "Reference implementation in Tier-1 SDKs" with no
  status. Third-party articles quote that row as if the SEP were still ideating. It is not.
- **Extension identifier:** `io.modelcontextprotocol/events`. It is defined for protocol revision
  **`2026-07-28` and later only**, because it relies on per-request client capabilities,
  `server/discover` and `subscriptions/listen`.

## The base protocol it rides on (`2026-07-28`)

The `2026-07-28` revision changed MCP more than any revision before it, and Hookbench has to speak
it, so these rules matter as much as the SEP:

- **MCP is stateless.** The `initialize` / `notifications/initialized` handshake is gone, and so
  are protocol sessions and the `Mcp-Session-Id` header. Every request carries
  `_meta["io.modelcontextprotocol/protocolVersion"]`,
  `_meta["io.modelcontextprotocol/clientCapabilities"]` and (SHOULD)
  `_meta["io.modelcontextprotocol/clientInfo"]`. Servers SHOULD put
  `io.modelcontextprotocol/serverInfo` in each result's `_meta`.
- **`server/discover` is mandatory for servers.** It returns `supportedVersions`,
  `capabilities` and `_meta.serverInfo`. Clients MAY call it first.
- **Every result carries `resultType`** (`"complete"`, or `"input_required"` for multi round-trip
  requests). Clients MUST treat a missing `resultType` from an older server as `"complete"`.
- **Streamable HTTP:** one MCP endpoint, POST only (the GET stream is gone). The client MUST send
  `Accept: application/json, text/event-stream`, the `MCP-Protocol-Version` header (MUST match the
  `_meta` version) and `Mcp-Method` on every request. The server answers with one JSON object or
  with an SSE stream scoped to that request. Closing that stream cancels the request. SSE
  resumability (`Last-Event-ID`) was removed.
- **`Mcp-Name`** carries `params.name`. Values that are not plain ASCII use the Base64 sentinel
  `=?base64?…?=`. A missing or mismatched header is rejected with HTTP `400` and `HeaderMismatch`
  (`-32020`).
- **Error-code ranges:** `-32000` to `-32019` is legacy and must not get new codes; `-32020` to
  `-32099` is reserved for the specification. Core codes: `-32020 HeaderMismatch`,
  `-32021 MissingRequiredClientCapability`, `-32022 UnsupportedProtocolVersion`. An unknown method
  over HTTP returns `404` with `-32601`.
- **Extension negotiation:** extensions live in `capabilities.extensions`, a map from identifier
  to a settings object. An empty object means "supported, no settings".
- **Backward compatibility:** a client MAY try a modern request first and fall back to
  `initialize` when the `400` body is not a recognised modern error.

## Methods and messages, exactly

The brief expected `events/list`, `events/subscribe` and `events/unsubscribe`. **The spec has five
methods and six notifications**, and `events/subscribe` / `events/unsubscribe` are used **only for
webhook delivery**.

| Message | Direction | Used by |
| --- | --- | --- |
| `events/list` | request | discovery, all modes |
| `events/poll` | request | poll mode (no subscribe step) |
| `events/stream` | long-lived request | push mode (no subscribe step) |
| `events/subscribe` | request | webhook mode only (create and refresh) |
| `events/unsubscribe` | request | webhook mode only |
| `notifications/events/list_changed` | server to client | only on a `subscriptions/listen` stream with `eventsListChanged: true` |
| `notifications/events/active` | on a push stream | confirms the stream; carries `cursor`, `truncated`, `heartbeatMs` |
| `notifications/events/event` | on a push stream | one `EventOccurrence` |
| `notifications/events/heartbeat` | on a push stream | keepalive that carries `cursor` |
| `notifications/events/error` | on a push stream | a recoverable per-occurrence failure; the stream stays open |
| `notifications/events/terminated` | on a push stream | the subscription ended |

Every result the extension defines carries `resultType: "complete"`.

### Capability

The server advertises support in `server/discover`:

```jsonc
{ "capabilities": { "extensions": { "io.modelcontextprotocol/events": { "listChanged": true } } } }
```

`listChanged` (optional boolean, default `false`) says whether the server sends
`notifications/events/list_changed`. A client MAY declare the identifier with `{}` in its
per-request capabilities. A server that does not offer Events answers any `events/*` request with
`-32601`. Prototypes of the design sketch advertised a top-level `capabilities.events` key instead;
the SEP says that key is not part of the extension.

### `events/list`

Params: optional `{cursor}` for pagination. Result: `{resultType, events: EventDescriptor[],
nextCursor?}`. Each descriptor:

| Field | Rule |
| --- | --- |
| `name` | string, the event type name |
| `description` | string |
| `delivery` | any non-empty subset of `"poll"`, `"push"`, `"webhook"`; no mode is mandatory |
| `inputSchema` | JSON Schema for subscription `arguments`; a property MAY carry `x-mcp-header` |
| `payloadSchema` | JSON Schema for `data` in delivered events |
| `_meta` | optional |

Schemas SHOULD evolve additively. A breaking change SHOULD ship under a new event name.

### `EventOccurrence`

| Field | Required | Notes |
| --- | --- | --- |
| `eventId` | yes | server-assigned; SHOULD be the upstream's stable id; deduplication is scoped to a subscription |
| `name` | yes | event type name |
| `timestamp` | yes | ISO 8601, when the event happened |
| `data` | yes | object conforming to `payloadSchema` |
| `cursor` | no | push and webhook only; `null` when the type has no replay; absent means `null` |
| `_meta` | no | not governed by `payloadSchema` |

### `events/poll`

Request: `{name, arguments, cursor, maxAgeMs?, maxEvents?}`. A `null` cursor means "start from now":
the server returns **no events** and a fresh cursor. Result:
`{resultType, events[], cursor, truncated, hasMore, nextPollMs}`. When `hasMore` is true the client
polls again at once; otherwise it waits `nextPollMs`. Clients SHOULD apply a floor (default 1000 ms).
Errors (`NotFound`, `Forbidden`, `InvalidParams`, `Unsupported`) are ordinary JSON-RPC errors. The
server keeps no protocol state for poll.

### `events/stream`

Request: `{name, arguments, cursor, maxAgeMs?, heartbeatMs?}`, one stream per subscription. An
invalid subscription gets an immediate JSON-RPC error and no stream. Otherwise the first message is
`notifications/events/active {cursor, truncated, heartbeatMs}`, and the grant in `heartbeatMs` is
authoritative (30 s is the recommended default). Every `notifications/events/*` message carries
`params._meta["io.modelcontextprotocol/subscriptionId"]` equal to the JSON-RPC `id` of the
`events/stream` request. The server MUST send a heartbeat whenever `heartbeatMs` passes without
another message. A client that hears nothing for 3 × `heartbeatMs` SHOULD reconnect with its
cursor. Over HTTP the client cancels by closing the request stream; over stdio it sends
`notifications/cancelled`. When the server ends the stream it MAY send a final
`{resultType:"complete", _meta:{subscriptionId}}`, and clients MUST NOT depend on it.

### `events/subscribe` (webhook)

```jsonc
{
  "name": "incident.created",
  "arguments": { "severity": "P1" },
  "delivery": { "mode": "webhook", "url": "https://proxy.example.com/hooks/client123", "secret": "whsec_…" },
  "cursor": null,
  "maxAgeMs": 300000,
  "ttlMs": 3600000      // omitted = server default, null = ask for no expiry
}
```

Result: `{resultType, id, refreshBefore, cursor, truncated, deliveryStatus?}`.

- **Authentication is required.** Calls without an authenticated principal MUST be rejected with
  `Forbidden`. Unauthenticated servers may offer poll and push but not webhook.
- **`delivery.secret` is required and client-supplied.** It MUST be `whsec_` + base64 of 24 to 64
  random bytes; anything else gets `InvalidParams`.
- **`delivery.url` MUST be `https`**; anything else gets `InvalidParams`.
- **Subscription key:** `(principal, delivery.url, name, arguments)`, with arguments compared as
  canonical JSON. The server derives a deterministic `id` from it, a routing handle that is never
  accepted as input.
- **Idempotent.** Calling again with the same key refreshes the TTL, replaces the secret (rotation;
  the server SHOULD dual-sign during a grace window) and reactivates suspended delivery.
- **TTL:** the client suggests `ttlMs`; the server grants `refreshBefore` (ISO timestamp, or
  `null` for no expiry). The grant SHOULD be ≤ the suggestion, except that a server MAY clamp a very
  short suggestion up to its floor. A server MUST NOT return `null` unless the client asked with
  `ttlMs: null`. The client MUST refresh before `refreshBefore`.
- **`deliveryStatus`** (optional, on refresh): `active`, `lastDeliveryAt`, `lastError` (one of
  `connection_refused`, `timeout`, `tls_error`, `http_4xx`, `http_5xx`, `challenge_failed`, never
  raw endpoint output), optional `failedSince`, `throttled`, `retryAfterMs`.

### `events/unsubscribe` (webhook)

Params: `{name, arguments, delivery: {url}}`, resolved with the same key. The result is an empty
`Result`. An unknown key returns `NotFound`. It is eager cleanup only, because subscriptions also
expire at their TTL. Poll subscriptions end when the client stops polling, and push subscriptions
end when the stream closes.

### Webhook delivery

```
POST <delivery.url>
Content-Type: application/json
webhook-id: msg_2KWPBgLlAfxdpx2AI54pPJ85f4W
webhook-timestamp: 1739980800
webhook-signature: v1,<base64 HMAC-SHA256(secret, id + "." + timestamp + "." + body)>
X-MCP-Subscription-Id: sub_a3f1c8e2b0d49f7e

{"eventId":"evt_789","name":"incident.created","timestamp":"2026-02-19T16:00:00Z","data":{…},"cursor":"cursor_xyz"}
```

- The HMAC key is the **base64-decoded bytes after `whsec_`**, and the MAC covers the **raw body
  bytes**. Several space-separated signatures MAY appear during rotation, and the receiver accepts
  if any one verifies. `v1a,` (ed25519) MAY be added for server identity.
- **`webhook-id` identifies the message, not the event.** It is high-entropy, reused across retries
  of that message, limited to `[A-Za-z0-9_-]`, and **MUST NOT be derived from `eventId`**. Control
  envelopes use `msg_<type>_<random>`. Retries keep the id and regenerate the timestamp and
  signature.
- The receiver MUST verify before processing, SHOULD reject timestamps more than 5 minutes old, and
  SHOULD dedupe on `webhook-id`. A `2xx` means "accepted, do not retry". `410` and `413` are
  non-retryable. A receiver that does not know the subscription id yet SHOULD answer `503` or `425`.
- The payload `cursor` is a **safe-to-persist watermark**, not the event's own position.
- Retries use exponential backoff and are bounded (for example 3 to 5 attempts over 10 to 15
  minutes). Bodies SHOULD stay at or under 256 KiB.
- **Control envelopes** (a body with a top-level `type`): `gap {cursor}`, `terminated {error}` and
  `verification {challenge}`.
- **Endpoint verification is mandatory** before the first delivery to an unverified
  `(principal, url)`, by one of: a signed `verification` challenge that the endpoint echoes as
  `{"challenge":"<nonce>"}` in a `2xx` body; a server allowlist; out-of-band verification; or a
  receiver-published `/.well-known/mcp-webhook-receiver.json` (`{"receivers":["/hooks/"]}`). On a
  first subscribe the challenge arrives while `events/subscribe` is still running. A failure returns
  `CallbackEndpointError` with `data.reason`.
- **SSRF:** servers MUST validate callback URLs, SHOULD reject non-globally-routable addresses
  (loopback, RFC 1918, link-local, ULA) unless explicitly configured to allow them, MUST re-check at
  delivery time, and MUST NOT follow redirects.

### Error codes (provisional until merged)

| Name | Code | Meaning |
| --- | --- | --- |
| `InvalidParams` | `-32602` | statically invalid: arguments fail `inputSchema`, non-`https` or malformed URL, bad `whsec_` secret |
| `NotFound` | `-32023` | unknown event name, or no subscription for the key on unsubscribe (`data.kind`) |
| `Forbidden` | `-32024` | principal not allowed, or access revoked |
| `ResourceExhausted` | `-32025` | a limit or quota (`data.limit`, `data.max`) |
| `Unsupported` | `-32026` | well-formed but not supported here, for example a delivery mode the type does not offer |
| `CallbackEndpointError` | `-32027` | webhook endpoint failed verification or was unreachable (`data.reason`) |

Design-sketch revisions before 2026-10-08 used `-32011` to `-32015`, a range the spec never
assigns, so older implementations need renumbering.

## How a subscription is created and delivered

| | Poll | Push | Webhook |
| --- | --- | --- | --- |
| Create | first `events/poll` with `cursor: null` | `events/stream` request | `events/subscribe` with `delivery {mode, url, secret}` |
| Confirm | the poll result | `notifications/events/active` | subscribe result `{id, refreshBefore}` after the verification handshake |
| Deliver | in the poll result | `notifications/events/event` on the stream | signed HTTP POST to the callback |
| Keep alive | keep polling (`nextPollMs`) | heartbeats; reconnect with cursor | re-subscribe before `refreshBefore` |
| Cursor in quiet periods | every poll result | heartbeat `cursor` | refresh response `cursor` |
| Gap | `truncated: true` in the result | fresh `active` with `truncated: true` | `truncated: true` on (re)subscribe, or a `gap` envelope |
| End | stop polling | close or cancel the stream | `events/unsubscribe`, or stop refreshing |

The client owns every subscription; there is no server-side "list subscriptions" method.

## Revocation and termination

Authorization is checked at subscribe time (`Forbidden`), and the server SHOULD re-check
periodically at delivery time. When access is revoked, or an event type is removed or changed
incompatibly, the server ends the subscription with the same nested `error` in every mode:
`notifications/events/terminated` on a push stream, a JSON-RPC error on the next `events/poll`, or a
signed `{"type":"terminated","error":{…}}` POST for webhooks. After a webhook termination, a refresh
is a fresh subscribe and returns `Forbidden` if the cause still applies. Removal uses `NotFound` with
`data.kind: "event"`; an in-place schema change uses `Unsupported` with
`data.reason: "schema_changed"`. Clients re-list and resubscribe on those, and stop on `Forbidden`.
Receiving an event never authorizes an action; the agent's response goes through normal MCP
authorization.

ChatGPT does not accept `terminated` envelopes, so for ChatGPT revocation means "the server stops
delivering". OpenAI's guide: "delivery stops if access is revoked".

## Three dialects in the wild

The SEP is not what most shipped code speaks yet. Everything in this table was checked against the
source named.

| | SEP-3415 | ChatGPT (OpenAI guide) | Design sketch (and code built on it) |
| --- | --- | --- | --- |
| Capability key | `capabilities.extensions["io.modelcontextprotocol/events"]` | top-level `capabilities.events` | top-level `capabilities.events` |
| Handshake | `server/discover`, revision `2026-07-28` | `initialize` example on `2025-03-26`, or `server/discover` on `2026-07-28`; both with top-level `events` | either |
| `resultType` | required | shown on `server/discover`; unsubscribe result is `{}` | absent |
| `webhook-id` | random per message, MUST NOT come from `eventId` | **equals `eventId`** | **equals `eventId`** |
| `CallbackEndpointError` | `-32027` | **`-32015`** | `-32015` before 2026-10-08, `-32027` after |
| Delivery modes | poll, push, webhook | **webhook only** | poll, push, webhook |
| `gap` / `terminated` envelopes | yes | **not supported** | yes |
| Body limit | SHOULD ≤ 256 KiB | 256 KiB hard limit, one event per request | SHOULD ≤ 256 KiB |

Evidence that this breaks real clients:

- **Vercel AI SDK only sees the top-level key.** `packages/mcp/src/tool/mcp-client.ts` (~line 856,
  `@ai-sdk/mcp` 2.0.101) throws `Server does not support events` for `events/list`,
  `events/subscribe` and `events/unsubscribe` unless `serverCapabilities.events` is set. A server
  that only advertises the SEP's `extensions` entry is invisible to it.
- **Vercel AI SDK and TanStack AI reject SEP-style webhook ids.**
  `packages/mcp/src/tool/mcp-event-webhook.ts` (~line 211) returns `400` when
  `event.data.eventId !== request.headers.get('webhook-id')`. TanStack's
  `packages/ai-mcp/src/events/webhook.ts` (~line 297) returns `400`
  `Event does not match the subscription` on the same mismatch, although it otherwise follows
  SEP-3415.
- **So no server can satisfy every consumer today.** A server that obeys the SEP's `webhook-id`
  rule has its deliveries rejected by ChatGPT-style receivers, the AI SDK and TanStack AI. Hookdeck's
  survey says servers send the `eventId` as the `webhook-id` "for now".
- **Secret encoding is a live interop bug.** A conformance reviewer found one SDK generating
  URL-safe base64 `whsec_` secrets that a server rejected
  ([conformance#521 comments](https://github.com/modelcontextprotocol/conformance/pull/521)).
  Hookbench generates standard base64.
- **The HMAC key is a classic mistake.** The conformance notes record a server that keyed the HMAC
  with the literal `whsec_…` string instead of the decoded bytes, so "no Standard Webhooks receiver
  verifies these signatures".

## Runtime support (2026-11-18)

**No official MCP SDK ships MCP Events.** The official TypeScript SDK (`@modelcontextprotocol/sdk`
1.32.2) has no `events/subscribe` code; the Python SDK (`mcp` 2.3.0) has an open PR,
[python-sdk#3822](https://github.com/modelcontextprotocol/python-sdk/pull/3822) (opened 2026-11-05),
not yet released.

| Runtime | Side | Modes | Status | Dialect | Source |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | client | webhook | shipping (DevDay 2026, all plans per the recap) | ChatGPT | OpenAI guide, Hookdeck |
| Vercel AI SDK `@ai-sdk/mcp` | client | webhook | experimental (`experimental_events`) | design sketch | source above |
| TanStack AI `@tanstack/ai-mcp` | client | webhook | experimental, since 1.0.0 | SEP-3415, but `webhook-id` = `eventId` | source above |
| Mastra `@mastra/mcp` | client and server | client: poll, webhook; server: poll, push | experimental, since 2.5.0 | SEP-3415 | Hookdeck; `packages/mcp/src/shared/events/` |
| Hermes Agent (Nous Research) | client | webhook | experimental, v0.22.5 | design sketch | Hookdeck |
| `mcp-handler` (Vercel Labs) | server | webhook | released 2.3.0 (now 2.4.0); [PR #199](https://github.com/vercel-labs/mcp-handler/pull/199) adds "both SEP and ChatGPT compat" | design sketch, moving to both | Hookdeck, PR |
| Skybridge (Alpic) | server | webhook | released 2.1.0 | design sketch + OpenAI guide | Hookdeck |
| `mcp-webhook-events` (PyPI 0.2.0) | server, on the official Python SDK | webhook | community; the SEP's cited reference server | ChatGPT-tested | SEP, PyPI |
| Hookdeck Event Gateway / Outpost | gateway | webhook | shipping | SEP-3415 (Outpost) | Hookdeck changelog |
| Claude / Claude Code | client | none | **not supported**; open feature request | — | Hookdeck |
| Official MCP Inspector | tool | none | **no Events support** (no `SEP-3415` hits in its tracker) | — | GitHub search |

The OpenAI DevDay recap (2026-09-29): "We're adding support for the proposed MCP Events
specification, so plugins can start automations when something happens in a connected app." Its
example is ChatGPT watching a project board and drafting a plan when a new task appears.

## What changed from the brief

1. **Five methods, not three.** `events/list`, `events/poll`, `events/stream`, `events/subscribe`,
   `events/unsubscribe`, plus six `notifications/events/*`. `events/subscribe` and
   `events/unsubscribe` are webhook-only. Poll and push have no subscribe step. Hookbench `connect`
   and `check` cover all three modes.
2. **There is no "emit" or "fire" method.** Events originate upstream, inside the server. So
   `hookbench fire` triggers the bundled reference server through a dev-only endpoint outside the
   MCP endpoint, or signs and POSTs a delivery straight to a webhook receiver. Against your own
   server, you trigger your upstream.
3. **Webhook mode requires authentication.** Hookbench builds no auth, but it lets you pass a header
   (`--header "Authorization: Bearer …"`), and the reference server accepts a fixed dev token so
   that webhook mode works offline.
4. **Callbacks must be `https` and publicly routable.** A strict server will refuse
   `http://127.0.0.1`. Poll and push deliver locally with no callback. For webhooks, Hookbench
   accepts a public `--callback-url` (a tunnel to its local receiver), and the reference server has
   an explicit dev flag that allows loopback, the same approach the official conformance harness and
   other reference servers use.
5. **Protocol `2026-07-28` is stateless.** Hookbench uses `server/discover` and per-request `_meta`
   instead of `initialize`, and falls back to `initialize` for ChatGPT-dialect servers.
6. **Real consumers disagree with the SEP.** Hookbench therefore has a `--profile` switch:
   `sep-3415` (default) and `chatgpt`.
7. **An official conformance suite is in review** (#521, #541, unmerged). Hookbench's `check` is a
   fast, profile-aware check with plain-language failure reasons and a GitHub Action, not a
   replacement for that suite.
8. **The working group is now the Tasks and Events WG**, and the SEP is Accepted (2026-11-11), not
   ideating.

## Decisions for Hookbench, from these notes

- Speak `2026-07-28` Streamable HTTP natively: `server/discover`, `_meta` on every request, the
  `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers (with the Base64 sentinel), JSON or
  SSE responses, and `resultType`.
- Accept both capability keys, and report which one the server used and which consumers can see it.
- In the receiver, verify Standard Webhooks signatures over the raw body. When a signature fails,
  test the known mistakes (literal secret as key, URL-safe base64, re-serialized body, a different
  id) and name the one that matches.
- Generate secrets as `whsec_` + standard base64 of 32 CSPRNG bytes.
- Answer verification challenges. Track `webhook-id` for dedup, and scope `eventId` dedup to the
  subscription.
- Refresh webhook subscriptions before `refreshBefore`, poll with a 1000 ms floor and honour
  `hasMore`, and watch push streams for 3 × `heartbeatMs` of silence.
- Ship a reference server that is strict by default (rejects `http`, private hosts and bad
  secrets; requires a principal for webhooks), with dev flags that relax only what local work
  needs, and fault switches that break exactly one rule each for the test fixtures.

## Keyword and landscape research (for SEO and AEO)

### Search demand, measured

Google autocomplete (`suggestqueries.google.com`, `hl=en`) and DuckDuckGo autocomplete, queried on
2026-11-18. An entry in the right column means people search it; "none" means no autocomplete
volume yet, which for a two-month-old feature usually means an open gap, not zero interest.

| Query | Autocomplete suggestions |
| --- | --- |
| `mcp events` | mcp events, **mcp events openai**, **mcp events spec**, **mcp events claude**, **mcp events chatgpt**, mcp events protocol, mcp server events |
| `what is mcp events` | what is mcp events |
| `chatgpt mcp events` | chatgpt mcp events |
| `mcp events test` / `testing` / `example` / `tutorial` / `github` / `typescript` / `python` / `webhook` / `sdk` | none (open) |
| `sep-3415` | none (exact-id query; answer engines quote exact ids) |
| `mcp inspector` | mcp inspector **tool / command / github / npx / cli / docker / install / versions** (strong) |
| `mcp inspector events` | none (open) |
| `mcp mock server` | mcp mock server, **mock mcp server for testing**, dummy mcp server for testing |
| `mcp test client` | mcp test client, mcp client test tool, mcp test tool, mcp server test client |
| `test mcp server` | test mcp server **online / locally / with curl / with postman / with mcp inspector** |
| `mcp server testing` | mcp server testing tool, mcp server testing framework, mcp server tester |
| `mcp conformance` | mcp conformance test, mcp conformance test framework |
| `mcp webhook` | mcp webhook, mcp webhook proxy, webhook mcp server, mcp vs webhook |
| `mcp push notifications` | mcp server push notifications |
| `mcp event driven` | event driven mcp server |
| `webhook.site alternative` | webhook site alternative **self hosted / local / open source** |
| `test webhooks locally` | test webhook locally stripe, how to test webhooks |
| `webhook signature verification` | **webhook signature verification failed**, … failed stripe, validation |
| `hmac webhook` | hmac webhook signature, webhook hmac sha256 |
| `standard webhooks` | standard webhooks npm, standard webhooks specification |
| `mcp github action` | mcp server github actions |
| `mcp ci`, `test mcp server github action` | none |

### What already ranks

- **Explainers for "MCP Events" are crowded:** Hookdeck ("What Are MCP Events and How Do They
  Work?", plus an MCP Events guide and changelog), Svix ("How ChatGPT MCP Events Work"), Apidog
  ("MCP Events explained: build and test a webhook-emitting MCP server ChatGPT can subscribe to",
  2026-10-02, also syndicated in three languages on DEV), WorkOS (subscription revocation),
  Upstash, forkast, mixed-news, developersdigest, nerdleveltech, explainx. Hookbench should not try
  to win the head term with another explainer.
- **Nobody ships an MCP Events testing tool.** Apidog's "test it" section sells its own API client
  plus a hand-written receiver script. The generic MCP testing pages (MCP Inspector, MCPJam,
  hikmahtechnologies, apigene) do not cover events at all. The official Inspector has no Events
  support.
- **GitHub repos are tiny.** The biggest MCP Events repo is
  [hookdeck/mcp-events-bridge](https://github.com/hookdeck/mcp-events-bridge) with 9 stars (a hosted
  webhook-to-MCP-Events bridge). Others: sanity-labs/pi-mcp-events (7), clareliguori's serverless
  earthquake agent (5), rohanprichard/mcp-events-starter (3), drasi-mcp-events (3),
  ImSingee/mcp-webhook-events (1). No inspector, mock client, test bench or conformance tool exists.
- **GitHub Marketplace has nothing for the terms.** Searches for `mcp events`, `sep-3415`,
  `standard webhooks`, `webhook receiver` and `hookbench` return 0 Actions. `mcp conformance` returns
  10 Actions, all for MCP servers in general (for example MCProbe, mcp-probe, mcp-doctor, MCP
  Conformance Gate). Details belong in `docs/MARKETPLACE-SEO.md` (Phase 5).

### Gaps to target

1. **Testing intent for MCP Events:** "test MCP Events", "MCP Events testing tool", "MCP Events
   mock client", "MCP Events inspector", "test MCP Events locally", "MCP Events conformance".
   Open in search, empty on GitHub and Marketplace.
2. **ChatGPT compatibility:** "test MCP Events for ChatGPT", "ChatGPT MCP Events webhook-id". There
   is demand ("mcp events chatgpt", "mcp events openai"), and the dialect table above is a unique,
   verifiable answer nobody publishes.
3. **Borrowed vocabulary with proven demand:** "MCP Inspector", "mock MCP server for testing", "MCP
   test client", "webhook.site alternative (local, open source)", "test webhooks locally",
   "webhook signature verification failed".
4. **Exact ids that answer engines quote:** `SEP-3415`, `io.modelcontextprotocol/events`,
   `events/list`, `events/subscribe`, `events/poll`, `events/stream`, `X-MCP-Subscription-Id`,
   `whsec_`.

### Name collision

- **npm `hookbench` is taken** by kama-labs, "Local-first webhook & HTTP request inspector",
  version 0.1.7, updated 2026-11-02. `npx hookbench` would run their package, so our docs must never
  say that. Our package will be scoped (`@nhtanvir/hookbench`, binary `hookbench`), and until it is
  published the docs use `npx github:NHTanvir/hookbench`.
- **GitHub has a `Hookbench` organization** (created 2025-12-18, no public repos), and three other
  repos are named hookbench (juzorei: webhook debugging CLI and agent skill; waitdeadai: Claude Code
  hook calibration; gabriel-demes: React hooks). GitHub Marketplace rejects an Action name that
  matches an account, so the Action needs a keyword-led name, not just "Hookbench".
- **Consequence for SEO:** the bare brand is contested, so every surface pairs it with the category:
  "Hookbench for MCP Events".

### Target keywords

| Tier | Keywords | Where they go |
| --- | --- | --- |
| Primary | MCP Events, SEP-3415, test MCP Events | repo description, README H1 and first paragraph, Action name and tagline, blog title |
| Secondary | MCP Events mock client, MCP Events inspector, MCP Events conformance check, MCP webhooks, ChatGPT MCP Events | README headings, docs titles, topics |
| Supporting | Model Context Protocol, mock MCP server for testing, MCP test client, test MCP server locally, Standard Webhooks, webhook signature verification, webhook.site alternative for MCP | body copy, FAQ, docs |
| Exact ids | `io.modelcontextprotocol/events`, `events/list`, `events/poll`, `events/stream`, `events/subscribe`, `events/unsubscribe`, `X-MCP-Subscription-Id`, `whsec_` | explainer, FAQ, code blocks |
