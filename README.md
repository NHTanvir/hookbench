# Hookbench: test MCP Events (SEP-3415) locally and in CI

[![CI](https://github.com/NHTanvir/hookbench/actions/workflows/ci.yml/badge.svg)](https://github.com/NHTanvir/hookbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP Events: SEP-3415](https://img.shields.io/badge/MCP%20Events-SEP--3415-6f42c1.svg)](docs/what-is-mcp-events.md)

**Hookbench is a local test bench and mock client for MCP Events, the Model Context Protocol extension (SEP-3415) that lets an MCP server tell clients when something happens.** It subscribes to your MCP server the way ChatGPT or an agent SDK would. It shows every delivered event in a live inspector, and checks your `events/list`, `events/poll`, `events/stream`, `events/subscribe` and `events/unsubscribe` against the spec, on your machine or in CI as a GitHub Action. You can build an event-emitting MCP server without ChatGPT, an agent or a public URL.

```bash
npx github:NHTanvir/hookbench demo
```

That one command runs the whole loop offline. It starts a bundled reference MCP server and a mock consumer that subscribes in all three delivery modes (webhook, poll and push), and opens the inspector at `http://127.0.0.1:4400`. It needs Node.js 18 or newer and has no runtime dependencies.

## How do I test MCP Events in CI?

Add the **MCP Events Conformance Test (SEP-3415)** GitHub Action after the step that starts your MCP server. It runs `hookbench check`, which grades 35 conformance rules. It fails the job when a MUST requirement of SEP-3415 breaks, and names the fix for every failure:

```yaml
- name: MCP Events conformance test
  uses: NHTanvir/hookbench@v0.1.0
  with:
    url: http://127.0.0.1:3000/mcp
    headers: |
      Authorization: Bearer ${{ secrets.MCP_TOKEN }}
```

A complete workflow:

```yaml
name: MCP Events
on: [push, pull_request]

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - name: Start the MCP server
        run: npm start &
      - name: MCP Events conformance test
        uses: NHTanvir/hookbench@v0.1.0
        with:
          url: http://127.0.0.1:3000/mcp
          headers: |
            Authorization: Bearer ${{ secrets.MCP_TOKEN }}
          # optional: a dev-only endpoint that makes your server emit a test event
          trigger-url: http://127.0.0.1:3000/dev/emit
```

The Markdown report goes to the job summary, and the JSON report is the `report` output.

| Input | Default | What it does |
| --- | --- | --- |
| `url` | (required) | the MCP endpoint to test |
| `headers` | | one `Name: value` per line; webhook mode needs credentials |
| `profile` | `sep-3415` | `sep-3415`, or `chatgpt` for ChatGPT's dialect |
| `trigger-url` | | a dev endpoint that emits a test event when Hookbench POSTs `{"name", "data"}`; turns on the delivery rules |
| `callback-url` | | a public https URL forwarding to the receiver on port 4300, to test real deliveries on a strict server |
| `allow-loopback` | `false` | `true` when your server accepts `http://127.0.0.1` callbacks in CI on purpose |
| `strict` | `false` | `true` to fail on SHOULD warnings too |
| `timeout`, `delivery-wait`, `stream-watch` | `10000`, `5000`, `5000` | timing, in milliseconds |

| Output | Value |
| --- | --- |
| `passed` | `true` when no MUST requirement failed |
| `failures`, `warnings` | rule counts |
| `exit-code` | `0` pass, `1` fail, `2` usage error |
| `report` | path to the JSON report |

## What does Hookbench do?

| Command | What it does |
| --- | --- |
| `hookbench connect <mcp-url>` | A **mock MCP Events consumer**. It discovers your server, calls `events/list`, subscribes to every event type by poll, push or webhook, and receives the deliveries on your machine. |
| `hookbench fire <event-name>` | Emits a test event **end to end**, so you can watch it travel through each subscription. It can also sign a delivery and POST it straight to any webhook receiver. |
| The inspector | A **live log and a local web view** of active subscriptions and every delivered payload, with signature checks: webhook.site, but for MCP Events. |
| `hookbench check <mcp-url>` | An **MCP Events conformance check**: 35 rules, each linked to the requirement it grades in SEP-3415 or the base spec, with a specific reason for every failure. Deterministic, no LLM. |
| `hookbench serve` | A bundled **reference MCP Events server** (a mock MCP server for testing clients) with three sample event types. |
| `hookbench demo` | All of the above at once, fully offline. |

Hookbench speaks protocol revision `2026-07-28`: stateless requests, `server/discover`, per-request `_meta`, and the `Mcp-Method` / `Mcp-Name` headers. It falls back to the older `initialize` handshake when a server needs it.

## How do I test MCP Events locally?

Point the mock consumer at your server. Webhook subscriptions need an authenticated principal, so pass your token:

```bash
npx github:NHTanvir/hookbench connect http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Hookbench lists your event types and subscribes to each one. It picks the delivery mode the way SEP-3415's client guidance says: webhook when you gave it a callback URL, then push, then poll. Pin a mode or filter with arguments:

```bash
npx github:NHTanvir/hookbench connect http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_TOKEN" \
  --event ticket.created:webhook --event build.finished:poll \
  --args 'ticket.created={"priority":"urgent"}'
```

Then make your server emit something and watch it arrive. This is the real output of `hookbench demo --once`:

```text
connected  http://127.0.0.1:4100/mcp  hookbench-reference 0.1.0 · protocol 2026-07-28 · capability extensions · profile sep-3415
events/list: 3 event type(s)
  ticket.created     poll push webhook    Fires when a support ticket is opened.
  build.finished     poll push            Fires when a CI build completes.
  alert.fired        push webhook         Fires when a monitoring alert triggers. Emit-only: no replay, cursor is null.
11:34:22  build.finished   poll     active  every 1500 ms
11:34:22  alert.fired      push     active  id 6, heartbeat 5000 ms
11:34:22  ticket.created   webhook  verification challenge answered
11:34:22  ticket.created   webhook  active  id sub_5598f03954414ca0, refresh before 11:35:22
11:34:22  ticket.created   webhook  evt_d9bd8c24d972441c8e7e  signed ✓  {"ticketId":"T-1001","title":"Checkout returns a 500 for EU cards","priority":"normal","project":"web","url":…
11:34:22  alert.fired      push     evt_506d23211f5a4c11bd42    {"alertId":"A-700","severity":"P2","service":"payments","summary":"payments p99 latency above 2 s for 5 minut…
11:34:24  build.finished   poll     evt_67ebf3fc04af44c59fd6    {"buildId":"b-4800","branch":"main","status":"passed","durationMs":61000}

demo passed  3/3 event types delivered (webhook signature verified), no protocol problems
```

The consumer does what a client SDK does:
- **Poll:** it uses a 1000 ms floor and drains `hasMore`.
- **Push:** it opens one `events/stream` per subscription and reconnects with the last cursor after three silent heartbeat intervals.
- **Webhook:** it generates a `whsec_` secret per subscription, verifies every delivery, refreshes before `refreshBefore`, and unsubscribes when you press Ctrl+C.

The full walkthrough is in [Getting started](docs/getting-started.md).

### How do webhook deliveries reach my laptop?

SEP-3415 says a server MUST refuse callback URLs that are not `https`, and SHOULD refuse private addresses, so a conformant server will not POST to `http://127.0.0.1`. Hookbench gives you two ways around that:

- **A tunnel.** Run `ngrok http 4300` or `cloudflared tunnel --url http://localhost:4300`. Then pass the public URL with `--callback-url https://<your-tunnel>`, and Hookbench's receiver listens on port 4300 behind it.
- **A dev flag on the server.** Allow loopback callbacks while developing, as `hookbench serve --allow-loopback-callbacks` does. Poll and push need neither, because they deliver over the MCP connection itself.

### How do I fire a test event?

The protocol has no "emit" method: events start upstream, inside the server. `hookbench fire` triggers one on the reference server, which then delivers it to every matching subscription:

```bash
npx github:NHTanvir/hookbench fire ticket.created --payload ticket.json
```

```text
fired ticket.created evt_099f4b7da0f04f9f80eb  → push 0 stream(s) · webhook 0 subscription(s) · poll subscribers get it on their next poll
```

To test your own webhook receiver, sign a delivery with the receiver's secret and send it straight there:

```bash
npx github:NHTanvir/hookbench fire ticket.created --to https://example.com/hooks/mcp --secret whsec_… --data '{"ticketId":"T-1"}'
```

## How do I check an MCP server against SEP-3415?

```bash
npx github:NHTanvir/hookbench check http://localhost:3000/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

The check probes your server the way a client would and grades 35 rules:
- discovery and capability
- `events/list`
- error codes and routing headers
- poll, push, webhook subscriptions and webhook deliveries

Each result names the requirement and links to its section of the SEP:

```text
hookbench check  http://127.0.0.1:4100/mcp  (profile sep-3415)
server   hookbench-reference 0.1.0 · protocol 2026-07-28 · capability: extensions

Discovery and capability
  ✓ PASS  discover.responds            server/discover answers
                                      protocol 2026-07-28, server hookbench-reference 0.1.0
  ✓ PASS  capability.declared          Events is advertised in capabilities
                                      capabilities.extensions["io.modelcontextprotocol/events"] = {}
…
  ✓ PASS  subscribe.verification       the callback is verified before any delivery
                                      unreachable callback refused with CallbackEndpointError (-32027) (reason connection_refused); signed verification challenge received and echoed before the subscription became active
…
35 rules: 33 pass · 0 fail · 0 warn · 1 skip · 1 info  (4.0 s)
PASS no MUST requirement failed
```

| Rule group | What it grades |
| --- | --- |
| Discovery | `server/discover` answers with `resultType`, and Events is advertised under `capabilities.extensions["io.modelcontextprotocol/events"]` |
| `events/list` | descriptors have a name, a non-empty `delivery` subset, `inputSchema` and `payloadSchema`; `nextCursor` pages correctly |
| Errors and headers | `NotFound` (-32023), `Unsupported` (-32026), `InvalidParams` (-32602), and `400 HeaderMismatch` (-32020) for a wrong `Mcp-Name` |
| Poll | `cursor: null` starts from now, the cursor resumes, results carry `truncated` / `hasMore` / `nextPollMs`, occurrences match `payloadSchema` |
| Push | `events/stream` opens with `notifications/events/active`, tags every notification with the subscription id, heartbeats when quiet |
| Webhook subscriptions | `Forbidden` without a principal, `InvalidParams` for `http://` and bad `whsec_` secrets, SSRF refusal, endpoint verification, TTL grants, idempotent subscribe, unsubscribe and `NotFound` |
| Webhook deliveries | Standard Webhooks headers, a v1 HMAC over the raw body, `webhook-id` rules, fresh timestamps, the `EventOccurrence` shape, 256 KiB bodies |

The exit code is 1 when any MUST fails (and on SHOULD warnings with `--strict`), so the check can gate a pull request. Run `hookbench check --help` for the options:
- `--trigger-url` makes the server emit test events.
- `--callback-url` tests real deliveries on a strict server.
- `--format json|markdown` and `--summary "$GITHUB_STEP_SUMMARY"` produce reports.

### What does a failure look like?

Every failure says what was wrong and how to fix it. This is a real run against a server that signs deliveries incorrectly:

```text
  ✗ FAIL  delivery.signature           the v1 HMAC signature verifies over the raw body
                                      no v1 signature matches the subscription secret: the sender used the literal "whsec_…" string as the HMAC key; decode the base64 after the prefix and use those bytes
```

## Will ChatGPT accept my MCP Events server?

Not necessarily, because ChatGPT does not speak SEP-3415 exactly. OpenAI's [MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) describes a dialect that differs from the SEP in ways no single server can satisfy at once:

| | SEP-3415 | ChatGPT |
| --- | --- | --- |
| Where Events is advertised | `capabilities.extensions["io.modelcontextprotocol/events"]` | top-level `capabilities.events` |
| `webhook-id` header | a random id per message; MUST NOT be derived from `eventId` | **must equal** `eventId` |
| `CallbackEndpointError` code | `-32027` | `-32015` |
| Delivery modes | poll, push, webhook | webhook only; no `gap` or `terminated` envelopes |

Some client SDKs take the ChatGPT side, and the source code shows it:
- **The Vercel AI SDK** only reads the top-level `capabilities.events` key.
- **Both the Vercel AI SDK and TanStack AI** reject a delivery whose `webhook-id` differs from its `eventId` with `400`.

[docs/RESEARCH.md](docs/RESEARCH.md) cites the file and line for both. Test against the dialect you ship to:

```bash
npx github:NHTanvir/hookbench check http://localhost:3000/mcp --profile chatgpt --header "Authorization: Bearer $MCP_TOKEN"
npx github:NHTanvir/hookbench connect http://localhost:3000/mcp --profile chatgpt --header "Authorization: Bearer $MCP_TOKEN"
```

Every check also ends with an `interop.consumers` note saying which shipped clients can see your server's events.

## Why does my webhook signature verification fail?

MCP Events signs webhooks with [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md): `v1,` + base64 HMAC-SHA256 of `webhook-id.webhook-timestamp.body`. The key is the base64-decoded bytes after `whsec_`, and the body is the raw bytes. When a signature does not verify, Hookbench's receiver re-computes it with the mistakes people actually make and names the one that matches:

- using the literal `whsec_…` string as the key
- using the base64 text as the key without decoding it
- hex output instead of base64
- signing a re-serialized copy of the JSON instead of the bytes sent
- signing the `eventId` while sending a different `webhook-id`
- signing a millisecond timestamp
- leaving the id or timestamp out of the signed content
- a missing `v1,` prefix

It also rejects timestamps more than 5 minutes old, deduplicates on `webhook-id`, and answers the `verification` challenge before the first delivery.

## What is in the reference server?

`hookbench serve` runs a small MCP server on `http://127.0.0.1:4100/mcp` with three sample event types:

| Event type | Delivery | Cursor | Arguments |
| --- | --- | --- | --- |
| `ticket.created` | poll, push, webhook | replayable | `priority` (enum), `project` |
| `build.finished` | poll, push | replayable | `branch` (mirrored into `Mcp-Param-Branch` via `x-mcp-header`), `status` |
| `alert.fired` | push, webhook | emit-only (`null`) | `severity` (enum) |

It is strict by default:
- callbacks must be `https` and public
- secrets must be valid `whsec_` values
- webhook mode needs `Authorization: Bearer hookbench-dev`

`--allow-loopback-callbacks` relaxes only the callback checks, for local work, and `--profile chatgpt` switches it to ChatGPT's dialect. `--fault <name>` breaks exactly one conformance rule, which is how Hookbench's own test suite proves each rule catches what it should (`hookbench serve --list-faults`).

## How is Hookbench different from the MCP Inspector and the official conformance suite?

The official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) has no MCP Events support yet (November 2026).

The official conformance suite for SEP-3415 is in review: [modelcontextprotocol/conformance#521](https://github.com/modelcontextprotocol/conformance/pull/521) for servers and [#541](https://github.com/modelcontextprotocol/conformance/pull/541) for clients. It is the authoritative, exhaustive grading harness. Hookbench is the developer's bench next to it:
- a mock consumer and an inspector to build against
- a fast check with plain-language fixes
- a ChatGPT profile
- a reference server to point your client at

## Can I use Hookbench as a library?

```bash
npm install --save-dev github:NHTanvir/hookbench
```

```ts
import { runCheck, formatText, startReferenceServer, startConsumer } from "@nhtanvir/hookbench";

const server = await startReferenceServer({ allowLoopbackCallbacks: true });
const report = await runCheck({
  url: server.url,
  headers: { Authorization: "Bearer hookbench-dev" },
  allowLoopback: true,
});
console.log(formatText(report, false));
await server.close();
```

It also exports:
- the mock consumer (`startConsumer`)
- the webhook receiver (`WebhookReceiver`)
- the client (`McpEventsClient`)
- the Standard Webhooks helpers (`signDelivery`, `verifyDelivery`, `generateSecret`)

## FAQ

### What is MCP Events?

MCP Events is an extension of the Model Context Protocol, identified as `io.modelcontextprotocol/events`. It lets an MCP client subscribe to things that happen in an upstream system, such as a new email, a push to a repository or an incident, and react when they occur, without a user asking. A server lists its event types with `events/list`, and delivers occurrences by poll (`events/poll`), push (`events/stream`) or signed webhooks (`events/subscribe`). The explainer [What is MCP Events?](docs/what-is-mcp-events.md) covers it in depth.

### What is SEP-3415?

SEP-3415 is the Specification Enhancement Proposal that defines MCP Events, numbered after its pull request, [modelcontextprotocol#3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415). The MCP Core Maintainers voted it **Accepted on 2026-11-11**, but it is not merged yet and needs a reference implementation in an official SDK before it becomes Final. Details can still change.

### Which methods does MCP Events define?

Five requests:
- `events/list`
- `events/poll`
- `events/stream`
- `events/subscribe`
- `events/unsubscribe`

And six notifications:
- `notifications/events/list_changed`
- `notifications/events/active`
- `notifications/events/event`
- `notifications/events/heartbeat`
- `notifications/events/error`
- `notifications/events/terminated`

`events/subscribe` and `events/unsubscribe` are used only for webhook delivery. Poll and push need no subscribe step.

### Is there a GitHub Action for MCP Events?

Yes. [MCP Events Conformance Test (SEP-3415)](#how-do-i-test-mcp-events-in-ci) runs `hookbench check` in GitHub Actions: `uses: NHTanvir/hookbench@v0.1.0` with the URL of your MCP server. It fails the job on any MUST failure and writes the report to the job summary.

### Can I test MCP Events without ChatGPT?

Yes. `hookbench connect` acts as the consumer, so your server never needs a ChatGPT workspace, an agent or a public URL while you build it. Use `--profile chatgpt` when you want the consumer to behave like ChatGPT.

### Does ChatGPT support MCP Events?

Yes, through webhooks only. OpenAI announced support for the proposed MCP Events specification at DevDay on 2026-09-29. OpenAI's guide describes a dialect that differs from SEP-3415; see the table above.

### Which SDKs support MCP Events?

No official MCP SDK ships it yet. As of November 2026:
- The official TypeScript SDK has no Events code.
- The Python SDK has an open pull request ([python-sdk#3822](https://github.com/modelcontextprotocol/python-sdk/pull/3822)).
- **Experimental support:** Vercel AI SDK (`@ai-sdk/mcp`), TanStack AI (`@tanstack/ai-mcp`), Mastra (`@mastra/mcp`) and `mcp-handler`.
- **Claude** does not support it yet.

[docs/RESEARCH.md](docs/RESEARCH.md) has the full table with sources.

### Why is the command `npx github:NHTanvir/hookbench` and not `npx hookbench`?

The npm name `hookbench` belongs to an unrelated webhook inspector, so `npx hookbench` would run someone else's package. Run Hookbench from this repository with `npx github:NHTanvir/hookbench`, or install it and use the `hookbench` binary. The package name is `@nhtanvir/hookbench`.

### Does Hookbench send my data anywhere?

No. Everything runs on your machine. `connect` and `check` only talk to the server URL you give them and to the `--trigger-url` you name. The inspector and the receiver bind to `127.0.0.1` and refuse requests addressed to any other host.

## Primary sources

- SEP-3415, Events Extension: [modelcontextprotocol/modelcontextprotocol#3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
- The design sketch it came from: [modelcontextprotocol/ext-events](https://github.com/modelcontextprotocol/ext-events/blob/main/docs/design-sketch-proposal.md)
- Tasks and Events Working Group charter: [modelcontextprotocol.io/community/triggers-events/charter](https://modelcontextprotocol.io/community/triggers-events/charter)
- MCP specification, revision 2026-07-28: [modelcontextprotocol.io/specification/2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- OpenAI's ChatGPT guide: [developers.openai.com/plugins/build/mcp-events](https://developers.openai.com/plugins/build/mcp-events)
- Standard Webhooks: [standard-webhooks.md](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)

What Hookbench was built from, with dates and versions: [docs/RESEARCH.md](docs/RESEARCH.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before you send a change: it checks every rule against a reference server broken in exactly that way.

## License

[MIT](LICENSE). MCP Events and SEP-3415 are the work of the Model Context Protocol project. Hookbench is an independent tool.
