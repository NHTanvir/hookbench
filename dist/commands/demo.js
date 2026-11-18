import { startConsumer } from "../consumer/consumer.js";
import { attachTerminalLog } from "../inspector/log.js";
import { InspectorStore } from "../inspector/store.js";
import { startInspectorWeb } from "../inspector/web.js";
import { startReferenceServer } from "../server/reference-server.js";
import { flagBool, flagInt, flagString, parseArgs } from "../util/args.js";
import { palette } from "../util/color.js";
import { defaultIo, parseProfile, RUN, untilInterrupted, useColor } from "./shared.js";
export const DEMO_HELP = `hookbench demo: the whole MCP Events loop on your machine, no network needed

Starts the bundled reference server and a mock consumer that subscribes to its three sample
event types, one per delivery mode: ticket.created by webhook (signed Standard Webhooks POSTs
to a local receiver), build.finished by poll (events/poll) and alert.fired by push
(events/stream). Then it fires events and shows every delivery in the terminal and in the
inspector web view.

Options
  --once            fire one event of each type, wait for all three deliveries, then exit
                    (exit code 0 when all three arrived and verified; handy in CI)
  --port <n>        inspector web view port (default 4400); --no-web turns it off
  --server-port <n> reference server port (default 4100, or a free one if that is taken)
  --every <ms>      fire a sample event this often (default 4000; 0 = only the first round)
  --profile <name>  sep-3415 (default) or chatgpt (everything over webhooks)
  --json            JSON lines instead of the human log
  --no-color        no ANSI colour
`;
const SPEC = {
    once: {},
    port: { value: true },
    web: {},
    "server-port": { value: true },
    every: { value: true },
    profile: { value: true },
    json: {},
    color: {},
    help: { alias: "h" },
};
const PLAN = [
    { name: "ticket.created", mode: "webhook", how: "signed Standard Webhooks POSTs to the local receiver" },
    { name: "build.finished", mode: "poll", how: "events/poll every nextPollMs" },
    { name: "alert.fired", mode: "push", how: "notifications on a long-lived events/stream" },
];
export async function runDemo(argv, io = defaultIo) {
    const args = parseArgs(argv, SPEC);
    if (flagBool(args, "help")) {
        io.out.write(DEMO_HELP);
        return 0;
    }
    const color = useColor(io, flagBool(args, "color", true) === false);
    const c = palette(color);
    const json = flagBool(args, "json");
    const once = flagBool(args, "once");
    const profile = parseProfile(flagString(args, "profile"));
    const every = flagInt(args, "every", 4000);
    const plan = profile === "chatgpt" ? PLAN.map((p) => ({ ...p, mode: "webhook", how: "signed webhooks, ChatGPT dialect" })) : PLAN;
    const serverOpts = {
        profile,
        allowLoopbackCallbacks: true,
        heartbeat: { defaultMs: 5000 },
        nextPollMs: 1500,
        ttl: { defaultMs: 60_000, minMs: 5000 },
    };
    let server;
    try {
        server = await startReferenceServer({ ...serverOpts, port: flagInt(args, "server-port", 4100) });
    }
    catch {
        server = await startReferenceServer({ ...serverOpts, port: 0 });
    }
    const store = new InspectorStore();
    let web;
    if (flagBool(args, "web", true) && !once) {
        web = await startInspectorWeb(store, { port: flagInt(args, "port", 4400) }).catch(() => startInspectorWeb(store, { port: 0 }));
    }
    if (!json) {
        io.out.write([
            `${c.bold("hookbench demo")}  ${c.dim("MCP Events (SEP-3415), fully offline")}`,
            `  reference server  ${server.url}  ${c.dim(`profile ${profile}, loopback callbacks allowed for the demo`)}`,
            web ? `  inspector         ${c.cyan(web.url)}` : "",
            ...plan.map((p) => `  ${p.name.padEnd(15)}   ${c.cyan(p.mode.padEnd(8))}${c.dim(p.how)}`),
            once ? "" : `  fire one yourself ${c.bold(`${RUN} fire ticket.created${server.origin === "http://127.0.0.1:4100" ? "" : ` --server ${server.origin}`}`)}`,
            once ? "" : `  check the server  ${c.bold(`${RUN} check ${server.url} --header "Authorization: Bearer hookbench-dev" --allow-loopback`)}`,
            once ? "" : c.dim("  Ctrl+C to stop"),
            "",
        ]
            .filter((l) => l !== "")
            .join("\n") + "\n");
    }
    else if (web)
        io.out.write(`${JSON.stringify({ type: "inspector", url: web.url })}\n`);
    const detach = attachTerminalLog(store, { out: io.out, color, json });
    const consumer = await startConsumer({
        url: server.url,
        profile,
        headers: { Authorization: `Bearer ${server.token ?? "hookbench-dev"}` },
        subscriptions: plan.map((p) => ({ name: p.name, mode: p.mode })),
        pollFloorMs: 1000,
        loopbackNotice: false,
        store,
    });
    // Give the subscriptions a moment to become active, then fire the first round.
    const waitActive = Date.now() + 5000;
    while (Date.now() < waitActive && [...store.subscriptions.values()].some((s) => s.status === "starting")) {
        await new Promise((r) => setTimeout(r, 50));
    }
    for (const p of plan)
        server.emit(p.name);
    let code = 0;
    if (once) {
        const deadline = Date.now() + 10_000;
        const delivered = () => plan.filter((p) => [...store.subscriptions.values()].some((s) => s.name === p.name && s.received > 0));
        while (Date.now() < deadline && delivered().length < plan.length)
            await new Promise((r) => setTimeout(r, 100));
        const got = delivered();
        const bad = store.feed.filter((f) => f.kind === "event" && (f.problems.length > 0 || f.signature === "invalid"));
        code = got.length === plan.length && bad.length === 0 ? 0 : 1;
        if (!json) {
            io.out.write(code === 0
                ? `\n${c.green(c.bold("demo passed"))}  ${c.dim(`${got.length}/${plan.length} event types delivered (webhook signature verified), no protocol problems`)}\n`
                : `\n${c.red(c.bold("demo failed"))}  ${got.length}/${plan.length} event types delivered, ${bad.length} with problems\n`);
        }
        else
            io.out.write(`${JSON.stringify({ type: "result", ok: code === 0, delivered: got.map((p) => p.name) })}\n`);
    }
    else {
        let i = 0;
        const timer = every > 0 ? setInterval(() => server.emit(plan[i++ % plan.length].name), every) : undefined;
        await untilInterrupted();
        if (timer)
            clearInterval(timer);
        if (!json)
            io.out.write(c.dim("\nstopping…\n"));
    }
    await consumer.stop();
    await web?.close();
    await server.close();
    detach();
    return code;
}
