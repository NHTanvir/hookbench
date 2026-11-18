# Getting started: test MCP Events locally with Hookbench

**To test MCP Events locally, run `npx github:NHTanvir/hookbench connect <your-mcp-url>`. Hookbench then acts as the MCP Events consumer: it subscribes to every event type your server lists and shows each delivery in a live inspector.** To check the same server against SEP-3415, run `npx github:NHTanvir/hookbench check <your-mcp-url>`. Everything runs on your machine; ChatGPT, an agent and a public URL are all optional.

New to the protocol? Read [What is MCP Events (SEP-3415)?](what-is-mcp-events.md) first.

## What do I need?

- **Node.js 18 or newer.** Hookbench has no runtime dependencies.
- **Your MCP server, reachable over Streamable HTTP**, for example `http://localhost:3000/mcp`.
- **For webhook mode, a credential.** SEP-3415 only allows webhook subscriptions for an authenticated principal, so have a token ready for `--header "Authorization: Bearer …"`.

## How do I see MCP Events working before writing any code?

```bash
npx github:NHTanvir/hookbench demo
```

The demo starts the bundled reference server on `http://127.0.0.1:4100/mcp` and subscribes to its three sample event types, one per delivery mode:

| Event type | Mode | How it arrives |
| --- | --- | --- |
| `ticket.created` | webhook | a signed Standard Webhooks POST to Hookbench's local receiver |
| `build.finished` | poll | in the result of `events/poll`, every `nextPollMs` |
| `alert.fired` | push | as `notifications/events/event` on a long-lived `events/stream` |

Open `http://127.0.0.1:4400` for the inspector's web view. Fire an event yourself from a second terminal:

```bash
npx github:NHTanvir/hookbench fire ticket.created
```

`hookbench demo --once` fires one event of each type, waits for all three deliveries, and exits with code 0 if every one arrived and verified. CI uses it as a smoke test.

## How do I connect Hookbench to my MCP server?

```bash
npx github:NHTanvir/hookbench connect http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Hookbench does what a client SDK does:

1. **Discovers the server.** It calls `server/discover` (protocol revision 2026-07-28) and falls back to the `initialize` handshake for older servers.
2. **Lists event types.** It calls `events/list`, following `nextCursor`, and prints each type with its delivery modes.
3. **Subscribes to each type.** It picks webhook when you gave it a public callback URL, then push, then poll, which is SEP-3415's client guidance.
4. **Shows every delivery** in the terminal and at `http://127.0.0.1:4400`, with signature checks and any problem it found.
5. **Cleans up on Ctrl+C.** It calls `events/unsubscribe` for webhook subscriptions and closes push streams.

Choose event types, modes and arguments yourself:

```bash
npx github:NHTanvir/hookbench connect http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_TOKEN" \
  --event incident.created:webhook \
  --event email.received:poll \
  --args 'incident.created={"severity":"P1"}'
```

`--args '{"…":…}'` without an event name applies to every event type. `--json` prints JSON lines instead of the human log, for piping into `jq`.

### Which delivery mode should I test?

Test every mode your `events/list` advertises; Hookbench supports all three.

| Mode | Your server implements | Hookbench, as the consumer |
| --- | --- | --- |
| Poll | `events/poll`: `cursor: null` starts from now; returns `events`, `cursor`, `hasMore`, `nextPollMs` | polls with a 1000 ms floor, drains `hasMore` at once, keeps the cursor |
| Push | `events/stream`: an SSE response that opens with `notifications/events/active`, then events and heartbeats | opens one stream per subscription and reconnects with the cursor after 3 silent heartbeat intervals |
| Webhook | `events/subscribe` / `events/unsubscribe`, a verification challenge, and signed POSTs | generates a `whsec_` secret, answers the challenge, verifies each POST, refreshes before `refreshBefore` |

### How do I receive webhook deliveries on localhost?

A conformant server refuses `http://` callbacks and SHOULD refuse private addresses, so it will not deliver to `http://127.0.0.1`. Put a tunnel in front of Hookbench's receiver:

```bash
# terminal 1: a public https URL that forwards to port 4300
cloudflared tunnel --url http://localhost:4300      # or: ngrok http 4300

# terminal 2: give that URL to Hookbench
npx github:NHTanvir/hookbench connect http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_TOKEN" \
  --callback-url https://your-tunnel.trycloudflare.com
```

Each subscription gets its own callback path, `/hooks/<token>`. Hookbench serves `/.well-known/mcp-webhook-receiver.json`, and it answers the `verification` challenge your server sends during `events/subscribe`.

The alternative is to let your server accept loopback callbacks in development. The reference server's `--allow-loopback-callbacks` flag does that. Keep the flag out of production.

## How do I trigger an event?

MCP Events has no "emit" method that a client can call: events start upstream, inside your server. To make one happen:

- **On your server**, cause the upstream thing: open a ticket, push a commit, send the email. Many teams add a dev-only endpoint that emits a test event. `hookbench check --trigger-url <url>` POSTs `{"name": "<event>", "data": {…}}` to such an endpoint, so the delivery rules can run.
- **On the reference server**, run `npx github:NHTanvir/hookbench fire <event-name>`. Add `--payload file.json` or `--data '{…}'` to choose the data, and `--terminate` to end every subscription to the type, which simulates revoked access.
- **On a webhook receiver**, run `npx github:NHTanvir/hookbench fire <event-name> --to <url> --secret whsec_…`. Hookbench signs an `EventOccurrence` the way an MCP server would and POSTs it.

## How do I check my server against the spec?

```bash
npx github:NHTanvir/hookbench check http://localhost:3000/mcp \
  --header "Authorization: Bearer $MCP_TOKEN" \
  --trigger-url http://localhost:3000/dev/emit
```

The check runs 35 rules and prints one line per rule.

| Status | Meaning |
| --- | --- |
| `PASS` | the requirement holds |
| `FAIL` | a MUST requirement is broken; the check exits 1 |
| `WARN` | a SHOULD is broken; exits 1 only with `--strict` |
| `SKIP` | the rule could not be observed. The detail says why, for example a missing trigger, credentials or a reachable callback. |
| `INFO` | interop notes, such as which shipped clients can see your events |

Useful options:
- `--callback-url` tests real webhook deliveries through a tunnel.
- `--allow-loopback` tells Hookbench your dev server accepts loopback callbacks on purpose.
- `--format json|markdown` and `--output report.json` produce machine-readable reports.

## How do I run the check in CI?

Start your server in the workflow, then run the check. The exit code fails the job when a MUST requirement breaks:

```yaml
- name: Start the MCP server
  run: npm start &
- name: MCP Events conformance
  run: |
    npx --yes github:NHTanvir/hookbench check http://127.0.0.1:3000/mcp \
      --header "Authorization: Bearer ${{ secrets.MCP_TOKEN }}" \
      --trigger-url http://127.0.0.1:3000/dev/emit \
      --summary "$GITHUB_STEP_SUMMARY"
```

`--summary` appends the Markdown report to the job summary.

## How do I test against ChatGPT's dialect?

Add `--profile chatgpt` to `connect` or `check`. ChatGPT reads the top-level `capabilities.events` key and uses webhooks only. It expects `webhook-id` to equal `eventId` and returns `-32015` for `CallbackEndpointError`. Each of those differs from SEP-3415; the table is in the [README](../README.md#will-chatgpt-accept-my-mcp-events-server).

## How do I test my MCP Events client instead of my server?

Point your client at the reference server:

```bash
npx github:NHTanvir/hookbench serve --allow-loopback-callbacks
# MCP endpoint: http://127.0.0.1:4100/mcp, webhook auth: Authorization: Bearer hookbench-dev
```

Then fire events at it with `hookbench fire`. To see how your client handles a server that gets something wrong, start the reference server with a fault:

```bash
npx github:NHTanvir/hookbench serve --allow-loopback-callbacks --fault stream-no-heartbeat
npx github:NHTanvir/hookbench serve --list-faults     # all 35
```

## What do the common errors mean?

| What you see | Why | What to do |
| --- | --- | --- |
| `HTTP 401: the server wants credentials` | an auth layer rejected the request | pass `--header "Authorization: Bearer <token>"` |
| `Forbidden (-32024)` on `events/subscribe` | webhook mode needs an authenticated principal | send credentials; unauthenticated servers may offer poll and push only |
| `InvalidParams (-32602): delivery.url must use https` | the callback was `http://127.0.0.1` | use `--callback-url https://<tunnel>`, or allow loopback callbacks on a dev server |
| `CallbackEndpointError (-32027)`, reason `connection_refused` / `timeout` | the server could not reach the callback URL | check that the tunnel is up and forwards to the receiver port (4300 with `--callback-url`) |
| `CallbackEndpointError`, reason `challenge_failed` | the endpoint did not echo the verification challenge | Hookbench echoes it automatically; another proxy in front may be changing the response |
| `HeaderMismatch (-32020)` | `Mcp-Name`, `Mcp-Method` or an `Mcp-Param-*` header did not match the body | Hookbench sends the right headers; a proxy may be dropping or rewriting them |
| `fell back to the initialize handshake` | the server does not implement `server/discover` (protocol 2026-07-28) | fine for ChatGPT's dialect; SEP-3415 servers MUST implement `server/discover` |
| `the server does not advertise MCP Events` | no `capabilities.extensions["io.modelcontextprotocol/events"]` and no `capabilities.events` | add the capability to your `server/discover` result |
| `no v1 signature matches the subscription secret: …` | the server signs deliveries wrongly | the rest of the line names the mistake, for example using the literal `whsec_` string as the key |
| `bad port` | Node's `fetch` refuses a few ports (such as 4190 and 6000) | run the server on another port |
| connection refused to `localhost` on Node 18 | Node 18 tries `::1` first | use `127.0.0.1` in the URL, or Node 20+ |

## Where next?

- [What is MCP Events (SEP-3415)?](what-is-mcp-events.md): the protocol in one page
- [README](../README.md): the conformance rules, ChatGPT compatibility, and the library API
- [Research notes](RESEARCH.md): every source Hookbench was built from, with dates
