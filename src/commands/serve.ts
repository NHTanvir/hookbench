import { FAULTS, startReferenceServer, type FaultName } from "../server/reference-server.js";
import { flagBool, flagInt, flagList, flagString, parseArgs, UsageError, type FlagSpec } from "../util/args.js";
import { palette } from "../util/color.js";
import { defaultIo, parseProfile, RUN, untilInterrupted, useColor, type Io } from "./shared.js";

export const SERVE_HELP = `hookbench serve: run the bundled reference MCP Events server

A small MCP server (Streamable HTTP, protocol 2026-07-28) with three sample event types:
ticket.created (poll, push, webhook), build.finished (poll, push) and alert.fired (push,
webhook; emit-only, no replay). Point an MCP Events client at it, or at \`hookbench check\`.

It is strict by default: webhook callbacks must be https and publicly routable, secrets must
be valid whsec_ values, and events/subscribe needs "Authorization: Bearer hookbench-dev".

Options
  --port <n>                  listen port (default 4100)
  --host <addr>               listen address (default 127.0.0.1)
  --profile <name>            sep-3415 (default) or chatgpt (top-level capability, webhook-id = eventId)
  --allow-loopback-callbacks  accept http://127.0.0.1 and private-network callbacks (dev only)
  --token <token>             bearer token for webhook mode (default hookbench-dev)
  --emit-every <ms>           emit a sample event on a timer
  --heartbeat <ms>            default push heartbeat interval (default 30000)
  --fault <name>              break one rule on purpose (repeatable); --list-faults shows them
  --quiet                     do not log requests
  --no-color                  no ANSI colour
`;

const SPEC: Record<string, FlagSpec> = {
  port: { value: true },
  host: { value: true },
  profile: { value: true },
  "allow-loopback-callbacks": {},
  token: { value: true },
  "emit-every": { value: true },
  heartbeat: { value: true },
  fault: { value: true, repeat: true },
  "list-faults": {},
  quiet: { alias: "q" },
  color: {},
  help: { alias: "h" },
};

export async function runServe(argv: string[], io: Io = defaultIo): Promise<number> {
  const args = parseArgs(argv, SPEC);
  if (flagBool(args, "help")) {
    io.out.write(SERVE_HELP);
    return 0;
  }
  if (flagBool(args, "list-faults")) {
    for (const [name, what] of Object.entries(FAULTS)) io.out.write(`${name.padEnd(34)} ${what}\n`);
    return 0;
  }
  const color = useColor(io, flagBool(args, "color", true) === false);
  const c = palette(color);
  const faults = flagList(args, "fault");
  for (const f of faults) if (!(f in FAULTS)) throw new UsageError(`unknown fault "${f}" (see --list-faults)`);
  const token = flagString(args, "token") ?? "hookbench-dev";
  const quiet = flagBool(args, "quiet");
  const heartbeat = flagString(args, "heartbeat") ? flagInt(args, "heartbeat", 30_000, 1000) : undefined;

  const server = await startReferenceServer({
    port: flagInt(args, "port", 4100),
    host: flagString(args, "host") ?? "127.0.0.1",
    profile: parseProfile(flagString(args, "profile")),
    allowLoopbackCallbacks: flagBool(args, "allow-loopback-callbacks"),
    tokens: { [token]: "dev" },
    autoEmitMs: flagString(args, "emit-every") ? flagInt(args, "emit-every", 0, 100) : undefined,
    heartbeat: heartbeat ? { defaultMs: heartbeat } : undefined,
    faults: faults as FaultName[],
    log: quiet ? undefined : (line) => io.out.write(`${c.gray(new Date().toLocaleTimeString())}  ${line}\n`),
  });

  io.out.write(
    [
      `${c.bold("hookbench reference server")}  ${c.dim(`profile ${server.profile.name}`)}`,
      `  MCP endpoint   ${server.url}`,
      `  fire events    ${RUN} fire ticket.created --server ${server.origin}`,
      `  check it       ${RUN} check ${server.url} --header "Authorization: Bearer ${token}"${flagBool(args, "allow-loopback-callbacks") ? " --allow-loopback" : ""}`,
      `  webhook auth   Authorization: Bearer ${token}`,
      flagBool(args, "allow-loopback-callbacks") ? c.yellow("  dev mode: http:// and private-network callbacks are accepted (a conformant server refuses them)") : "",
      faults.length ? c.yellow(`  faults on: ${faults.join(", ")}`) : "",
      c.dim("  Ctrl+C to stop"),
      "",
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n",
  );
  await untilInterrupted();
  await server.close();
  return 0;
}
