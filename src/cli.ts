#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHECK_HELP, runCheckCommand } from "./commands/check.js";
import { CONNECT_HELP, runConnect } from "./commands/connect.js";
import { DEMO_HELP, runDemo } from "./commands/demo.js";
import { FIRE_HELP, runFire } from "./commands/fire.js";
import { runServe, SERVE_HELP } from "./commands/serve.js";
import { defaultIo, RUN, type Io } from "./commands/shared.js";
import { UsageError } from "./util/args.js";
import { VERSION } from "./version.js";

export const HELP = `hookbench ${VERSION}: a local test bench and mock client for MCP Events (SEP-3415)

Usage
  ${RUN} demo                      the whole loop offline: reference server + mock consumer + inspector
  ${RUN} connect <mcp-url>         subscribe to a server's events and inspect every delivery
  ${RUN} fire <event-name>         emit an event on the reference server, or sign one to a webhook URL
  ${RUN} check <mcp-url>           conformance check against SEP-3415 or the ChatGPT dialect
  ${RUN} serve                     run the bundled reference MCP Events server

Run "${RUN} <command> --help" for a command's options.
Docs: https://github.com/NHTanvir/hookbench
`;

const HELPS: Record<string, string> = {
  demo: DEMO_HELP,
  connect: CONNECT_HELP,
  fire: FIRE_HELP,
  check: CHECK_HELP,
  serve: SERVE_HELP,
};

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h": {
        const topic = rest[0];
        io.out.write(topic && HELPS[topic] ? HELPS[topic] : HELP);
        return 0;
      }
      case "--version":
      case "-v":
      case "version":
        io.out.write(`${VERSION}\n`);
        return 0;
      case "demo":
        return await runDemo(rest, io);
      case "connect":
        return await runConnect(rest, io);
      case "fire":
        return await runFire(rest, io);
      case "check":
        return await runCheckCommand(rest, io);
      case "serve":
        return await runServe(rest, io);
      default:
        io.err.write(`hookbench: unknown command "${cmd}"\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write(`hookbench: ${err.message}\nRun "${RUN} ${cmd} --help" for options.\n`);
      return 2;
    }
    io.err.write(`hookbench: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // Everything is closed by now; this only guards against a stray handle keeping Node alive.
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
