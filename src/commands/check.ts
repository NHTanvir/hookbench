import { appendFileSync, writeFileSync } from "node:fs";
import { exitCodeFor, formatJson, formatMarkdown, formatText } from "../check/report.js";
import { runCheck } from "../check/runner.js";
import { flagBool, flagInt, flagList, flagString, parseArgs, parseHeaders, UsageError, type FlagSpec } from "../util/args.js";
import { defaultIo, parseProfile, requireUrl, useColor, type Io } from "./shared.js";

export const CHECK_HELP = `hookbench check <mcp-url>: MCP Events conformance check (SEP-3415 or the ChatGPT dialect)

Probes the server the way a client would: server/discover, events/list, events/poll,
events/stream, events/subscribe and events/unsubscribe, then grades every webhook delivery.
Each rule names the requirement it checks. Deterministic, no LLM.

Exit code: 0 when no MUST requirement fails, 1 when one does (or a SHOULD fails with --strict),
2 for a usage error.

Options
  --profile <name>          sep-3415 (default) or chatgpt
  --header "Name: value"    send a header on every request, e.g. "Authorization: Bearer <token>" (repeatable)
  --trigger-url <url>       POST {name, data} here to make the server emit a test event
                            (found automatically on a Hookbench reference server)
  --callback-url <url>      public https URL forwarding to Hookbench's receiver, to test real deliveries
  --allow-loopback          the server accepts http://127.0.0.1 callbacks on purpose (dev mode)
  --receiver-port <n>       local receiver port (default 4300 with --callback-url, otherwise random)
  --timeout <ms>            per-request timeout (default 10000)
  --delivery-wait <ms>      how long to wait for a delivery after a trigger (default 5000)
  --stream-watch <ms>       longest time to watch a push stream for heartbeats (default 5000)
  --format <f>              text (default), json or markdown
  --output <file>           also write the report to a file: .json, .md, or text for anything else
  --summary <file>          append the Markdown report to a file, e.g. "$GITHUB_STEP_SUMMARY"
  --strict                  exit 1 on SHOULD warnings too
  --no-color                no ANSI colour
`;

const SPEC: Record<string, FlagSpec> = {
  profile: { value: true },
  header: { value: true, repeat: true, alias: "H" },
  "trigger-url": { value: true },
  "callback-url": { value: true },
  "allow-loopback": {},
  "receiver-port": { value: true },
  timeout: { value: true },
  "delivery-wait": { value: true },
  "stream-watch": { value: true },
  format: { value: true },
  output: { value: true, alias: "o" },
  summary: { value: true },
  strict: {},
  color: {},
  quiet: { alias: "q" },
  help: { alias: "h" },
};

export async function runCheckCommand(argv: string[], io: Io = defaultIo): Promise<number> {
  const args = parseArgs(argv, SPEC);
  if (flagBool(args, "help")) {
    io.out.write(CHECK_HELP);
    return 0;
  }
  const url = requireUrl(args.positionals[0], "the MCP server URL (for example http://127.0.0.1:4100/mcp)");
  const format = flagString(args, "format") ?? "text";
  if (!["text", "json", "markdown"].includes(format)) throw new UsageError(`--format must be text, json or markdown, got "${format}"`);
  const callbackUrl = flagString(args, "callback-url");
  if (callbackUrl !== undefined && !callbackUrl.startsWith("https://")) throw new UsageError("--callback-url must be a public https URL");
  const color = useColor(io, flagBool(args, "color", true) === false);
  const quiet = flagBool(args, "quiet");

  const report = await runCheck({
    url,
    profile: parseProfile(flagString(args, "profile")),
    headers: parseHeaders(flagList(args, "header")),
    triggerUrl: flagString(args, "trigger-url"),
    callbackUrl,
    allowLoopback: flagBool(args, "allow-loopback"),
    receiverPort: flagString(args, "receiver-port") ? flagInt(args, "receiver-port", 0) : callbackUrl ? 4300 : 0,
    timeoutMs: flagInt(args, "timeout", 10_000, 1),
    deliveryWaitMs: flagInt(args, "delivery-wait", 5000, 0),
    streamWatchMs: flagInt(args, "stream-watch", 5000, 0),
    progress: quiet || format !== "text" ? undefined : (line) => io.err.write(color ? `\u001b[2m… ${line}\u001b[22m\n` : `… ${line}\n`),
  });

  const rendered = format === "json" ? formatJson(report) : format === "markdown" ? formatMarkdown(report) : formatText(report, color);
  io.out.write(`${rendered}\n`);
  const output = flagString(args, "output");
  if (output) {
    // The file's extension picks its format, so CI can log text and keep a JSON report.
    const ext = output.toLowerCase().split(".").pop();
    const body =
      ext === "json" ? formatJson(report) : ext === "md" || ext === "markdown" ? formatMarkdown(report) : format === "text" ? formatText(report, false) : rendered;
    writeFileSync(output, `${body}\n`);
  }
  const summary = flagString(args, "summary");
  if (summary) appendFileSync(summary, `${formatMarkdown(report)}\n`);
  return exitCodeFor(report, flagBool(args, "strict"));
}
