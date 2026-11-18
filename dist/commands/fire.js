import { isObject } from "../protocol/jsonrpc.js";
import { flagBool, flagList, flagString, parseArgs, parseHeaders, UsageError } from "../util/args.js";
import { palette } from "../util/color.js";
import { postWebhook } from "../webhooks/post.js";
import { makeWebhookId, secretProblem, signDelivery } from "../webhooks/standard-webhooks.js";
import { defaultIo, parseJsonObject, readJsonFile, useColor } from "./shared.js";
export const FIRE_HELP = `hookbench fire <event-name>: emit an MCP Events event so you can watch it get delivered

MCP Events has no "emit" method: events start upstream, inside the server. So fire works in
one of two ways:

  1. Against the bundled reference server (hookbench serve / hookbench demo), through its
     dev-only /hookbench/fire endpoint. The server then delivers the event to every matching
     subscription by poll, push or webhook, exactly as it would for a real upstream event.
  2. Straight to a webhook receiver with --to: Hookbench builds an EventOccurrence, signs it with
     Standard Webhooks (--secret), and POSTs it, like an MCP server would.

Options
  --payload <file.json>     the event's data object, from a file
  --data <json>             the event's data object, inline (default: a sample from payloadSchema)
  --event-id <id>           eventId to use (default: generated)
  --server <url>            reference server, its MCP URL or origin (default http://127.0.0.1:4100)
  --terminate               end every subscription to this event type instead (simulates revoked access)
  --to <url>                send a signed webhook delivery to this receiver instead of a server
  --secret <whsec_…>        signing secret for --to (required with --to)
  --subscription-id <id>    X-MCP-Subscription-Id for --to (default sub_hookbench)
  --webhook-id <id>         webhook-id for --to (default: random msg_…)
  --header "Name: value"    extra header for --to (repeatable)
  --json                    print the result as JSON
  --no-color                no ANSI colour
`;
const SPEC = {
    payload: { value: true, alias: "p" },
    data: { value: true, alias: "d" },
    "event-id": { value: true },
    server: { value: true, alias: "s" },
    terminate: {},
    to: { value: true },
    secret: { value: true },
    "subscription-id": { value: true },
    "webhook-id": { value: true },
    header: { value: true, repeat: true, alias: "H" },
    json: {},
    color: {},
    help: { alias: "h" },
};
function serverOrigin(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        throw new UsageError(`--server must be a URL, got "${raw}"`);
    }
    return u.origin;
}
export async function runFire(argv, io = defaultIo) {
    const args = parseArgs(argv, SPEC);
    if (flagBool(args, "help")) {
        io.out.write(FIRE_HELP);
        return 0;
    }
    const name = args.positionals[0];
    if (!name)
        throw new UsageError("missing the event name, for example: hookbench fire ticket.created");
    const color = useColor(io, flagBool(args, "color", true) === false);
    const c = palette(color);
    const json = flagBool(args, "json");
    let data;
    const payload = flagString(args, "payload");
    const inline = flagString(args, "data");
    if (payload && inline)
        throw new UsageError("use --payload or --data, not both");
    if (payload)
        data = readJsonFile(payload, "--payload");
    if (inline)
        data = parseJsonObject(inline, "--data");
    const eventId = flagString(args, "event-id");
    const to = flagString(args, "to");
    if (to) {
        const secret = flagString(args, "secret");
        if (!secret)
            throw new UsageError("--to needs --secret <whsec_…> (the secret the receiver expects)");
        const problem = secretProblem(secret);
        if (problem)
            throw new UsageError(`--secret: ${problem}`);
        const occurrence = {
            eventId: eventId ?? `evt_${makeWebhookId().slice(4, 24)}`,
            name,
            timestamp: new Date().toISOString(),
            data: data ?? {},
            cursor: null,
        };
        const body = JSON.stringify(occurrence);
        const headers = {
            ...signDelivery({ secrets: [secret], body, webhookId: flagString(args, "webhook-id") }),
            "x-mcp-subscription-id": flagString(args, "subscription-id") ?? "sub_hookbench",
            ...parseHeaders(flagList(args, "header")),
        };
        const resp = await postWebhook(to, body, headers, { allowPrivateNetworks: true, timeoutMs: 10_000 });
        if (json)
            io.out.write(`${JSON.stringify({ to, status: resp.status ?? null, ok: resp.ok, body: resp.body ?? null, error: resp.detail ?? null, occurrence, headers })}\n`);
        else {
            io.out.write(`${c.bold("POST")} ${to}\n${c.dim(`webhook-id ${headers["webhook-id"]} · X-MCP-Subscription-Id ${headers["x-mcp-subscription-id"]}`)}\n${body}\n`);
            if (resp.status !== undefined)
                io.out.write(`${resp.ok ? c.green(`→ ${resp.status}`) : c.red(`→ ${resp.status}`)}${resp.body ? ` ${resp.body.slice(0, 300)}` : ""}\n`);
            else
                io.out.write(`${c.red("→ failed")} ${resp.detail ?? resp.category}\n`);
        }
        return resp.ok ? 0 : 1;
    }
    const origin = serverOrigin(flagString(args, "server") ?? "http://127.0.0.1:4100");
    const path = flagBool(args, "terminate") ? "/hookbench/terminate" : "/hookbench/fire";
    let res;
    try {
        res = await fetch(`${origin}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, data, eventId }),
            signal: AbortSignal.timeout(10_000),
        });
    }
    catch (err) {
        const cause = err.cause?.code;
        io.err.write(`${c.red("error")} cannot reach a Hookbench reference server at ${origin}${cause ? ` (${cause})` : ""}.\nStart one with \`hookbench serve\` or \`hookbench demo\`, or pass --server <url>. To send a signed delivery to a webhook receiver, use --to <url> --secret <whsec_…>.\n`);
        return 1;
    }
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = undefined;
    }
    if (res.status === 404 && !(isObject(body) && "known" in body)) {
        io.err.write(`${c.red("error")} ${origin} has no ${path} endpoint, so it is not a Hookbench reference server.\nThe MCP Events spec has no way for a client to make a server emit an event; trigger your server's upstream instead (or add a dev-only endpoint like this one).\n`);
        return 1;
    }
    if (!res.ok || !isObject(body)) {
        const msg = isObject(body) ? String(body["error"] ?? text) : text;
        const known = isObject(body) && Array.isArray(body["known"]) ? ` Known event types: ${body["known"].join(", ")}.` : "";
        io.err.write(`${c.red("error")} ${msg}${known}\n`);
        return 1;
    }
    if (json) {
        io.out.write(`${JSON.stringify(body)}\n`);
        return 0;
    }
    if (path === "/hookbench/terminate") {
        io.out.write(`${c.yellow("terminated")} ${body["terminated"]} subscription(s) to ${name} (Forbidden: Access revoked)\n`);
        return 0;
    }
    const delivered = isObject(body["delivered"]) ? body["delivered"] : {};
    const modes = Array.isArray(body["modes"]) ? body["modes"] : [];
    const parts = [
        modes.includes("push") ? `push ${String(delivered["push"])} stream(s)` : "",
        modes.includes("webhook") ? `webhook ${String(delivered["webhook"])} subscription(s)` : "",
        modes.includes("poll") ? "poll subscribers get it on their next poll" : "",
    ].filter(Boolean);
    io.out.write(`${c.green("fired")} ${c.bold(name)} ${c.dim(String(body["eventId"]))}  → ${parts.join(" · ")}\n`);
    const warnings = Array.isArray(body["warnings"]) ? body["warnings"] : [];
    for (const w of warnings)
        io.out.write(`  ${c.yellow("!")} payload does not match payloadSchema: ${String(w)}\n`);
    return 0;
}
