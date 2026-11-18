import { startConsumer } from "../consumer/consumer.js";
import { attachTerminalLog } from "../inspector/log.js";
import { InspectorStore } from "../inspector/store.js";
import { startInspectorWeb } from "../inspector/web.js";
import { flagBool, flagInt, flagList, flagString, parseArgs, parseHeaders, UsageError } from "../util/args.js";
import { palette } from "../util/color.js";
import { defaultIo, parseJsonObject, parseMode, parseProfile, requireUrl, untilInterrupted, useColor } from "./shared.js";
export const CONNECT_HELP = `hookbench connect <mcp-url>: act as an MCP Events consumer against a server

Discovers the server (server/discover), lists its event types (events/list), subscribes
to each one, and shows every delivery live in the terminal and in a local web view.
Poll and push deliver over the MCP connection itself. Webhook deliveries arrive at a local
receiver that verifies their Standard Webhooks signatures.

Options
  --event <name>[:<mode>]   subscribe to this event type (repeatable); mode is auto, poll, push or webhook
  --args <name>=<json>      subscription arguments for one event type (repeatable), or --args <json> for all
  --mode <mode>             default mode: auto (default), poll, push or webhook
  --header "Name: value"    send a header on every request, e.g. "Authorization: Bearer <token>" (repeatable)
  --profile <name>          sep-3415 (default) or chatgpt (webhook only, ChatGPT's dialect)
  --callback-url <url>      public https URL that forwards to the local receiver (an ngrok/cloudflared tunnel)
  --receiver-port <n>       local webhook receiver port (default 4300 with --callback-url, otherwise random)
  --port <n>                inspector web view port (default 4400); --no-web turns it off
  --ttl <ms>                webhook TTL to ask for (default: the server's)
  --heartbeat <ms>          push heartbeat interval to ask for
  --legacy                  use the pre-2026-07-28 initialize handshake
  --json                    print JSON lines instead of the human log
  --no-color                no ANSI colour
`;
const SPEC = {
    event: { value: true, repeat: true, alias: "e" },
    args: { value: true, repeat: true },
    mode: { value: true },
    header: { value: true, repeat: true, alias: "H" },
    profile: { value: true },
    "callback-url": { value: true },
    "receiver-port": { value: true },
    port: { value: true },
    web: {},
    ttl: { value: true },
    heartbeat: { value: true },
    legacy: {},
    json: {},
    color: {},
    help: { alias: "h" },
};
export function parseSubscriptions(events, args) {
    const subs = events.map((spec) => {
        const idx = spec.lastIndexOf(":");
        if (idx > 0 && ["auto", "poll", "push", "webhook"].includes(spec.slice(idx + 1))) {
            return { name: spec.slice(0, idx), mode: parseMode(spec.slice(idx + 1), "--event") };
        }
        return { name: spec };
    });
    let allArgs;
    for (const a of args) {
        if (a.trimStart().startsWith("{")) {
            allArgs = parseJsonObject(a, "--args");
            continue;
        }
        const eq = a.indexOf("=");
        if (eq <= 0)
            throw new UsageError(`--args must be <event-name>=<json> or a JSON object, got "${a}"`);
        const name = a.slice(0, eq);
        const value = parseJsonObject(a.slice(eq + 1), `--args for ${name}`);
        const existing = subs.find((s) => s.name === name);
        if (existing)
            existing.arguments = value;
        else
            subs.push({ name, arguments: value });
    }
    if (allArgs)
        for (const s of subs)
            s.arguments ??= allArgs;
    return { subs, allArgs };
}
export async function runConnect(argv, io = defaultIo) {
    const args = parseArgs(argv, SPEC);
    if (flagBool(args, "help")) {
        io.out.write(CONNECT_HELP);
        return 0;
    }
    const url = requireUrl(args.positionals[0], "the MCP server URL (for example http://127.0.0.1:4100/mcp)");
    const profile = parseProfile(flagString(args, "profile"));
    const headers = parseHeaders(flagList(args, "header"));
    const callbackUrl = flagString(args, "callback-url");
    if (callbackUrl !== undefined && !callbackUrl.startsWith("https://")) {
        throw new UsageError("--callback-url must be a public https URL (servers refuse anything else)");
    }
    const json = flagBool(args, "json");
    const color = useColor(io, flagBool(args, "color", true) === false);
    const c = palette(color);
    const { subs, allArgs } = parseSubscriptions(flagList(args, "event"), flagList(args, "args"));
    const modeFlag = flagString(args, "mode");
    const mode = modeFlag ? parseMode(modeFlag) : "auto";
    const receiverPort = flagString(args, "receiver-port") ? flagInt(args, "receiver-port", 0) : callbackUrl ? 4300 : 0;
    const ttlMs = flagString(args, "ttl") ? flagInt(args, "ttl", 0) : undefined;
    const heartbeatMs = flagString(args, "heartbeat") ? flagInt(args, "heartbeat", 0, 1) : undefined;
    const store = new InspectorStore();
    let web;
    if (flagBool(args, "web", true)) {
        web = await startInspectorWeb(store, { port: flagInt(args, "port", 4400) }).catch(() => startInspectorWeb(store, { port: 0 }));
    }
    if (json) {
        if (web)
            io.out.write(`${JSON.stringify({ type: "inspector", url: web.url })}\n`);
    }
    else {
        io.out.write(`${c.bold("hookbench connect")}  ${url}  ${c.dim(`profile ${profile}`)}\n`);
        if (web)
            io.out.write(`${c.dim("inspector")}  ${c.cyan(web.url)}\n`);
    }
    const detach = attachTerminalLog(store, { out: io.out, color, json });
    let consumer;
    try {
        consumer = await startConsumer({
            url,
            profile,
            headers,
            subscriptions: subs.length > 0 ? subs : undefined,
            defaultArguments: allArgs,
            mode,
            callbackUrl,
            receiverPort,
            ttlMs,
            heartbeatMs,
            era: flagBool(args, "legacy") ? "legacy" : undefined,
            store,
        });
    }
    catch (err) {
        detach();
        await web?.close();
        throw err;
    }
    if (!json) {
        if (consumer.receiver)
            io.out.write(`${c.dim("receiver")}   ${consumer.receiver.baseUrl}${callbackUrl ? c.dim(`  (public: ${callbackUrl})`) : ""}\n`);
        io.out.write(c.dim("Ctrl+C to unsubscribe and stop\n"));
    }
    await untilInterrupted();
    if (!json)
        io.out.write(c.dim("\nstopping: unsubscribing webhook subscriptions…\n"));
    await consumer.stop();
    await web?.close();
    detach();
    return 0;
}
