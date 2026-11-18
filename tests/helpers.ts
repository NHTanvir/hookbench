import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runCheck, type CheckOptions, type CheckReport, type RuleResult } from "../src/check/runner.js";
import { startReferenceServer, type ReferenceServer, type ReferenceServerOptions } from "../src/server/reference-server.js";

export const AUTH = { Authorization: "Bearer hookbench-dev" };

/** A reference server tuned for fast tests: short heartbeats, fast retries, loopback callbacks. */
export function testServer(opts: ReferenceServerOptions = {}): Promise<ReferenceServer> {
  return startReferenceServer({
    allowLoopbackCallbacks: true,
    heartbeat: { defaultMs: 1000, minMs: 200 },
    retry: { attempts: 2, baseDelayMs: 50, timeoutMs: 2000 },
    nextPollMs: 200,
    ...opts,
  });
}

export async function withServer<T>(opts: ReferenceServerOptions, fn: (s: ReferenceServer) => Promise<T>): Promise<T> {
  const server = await testServer(opts);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

/** Run `hookbench check` against a server with the defaults the fixtures use. */
export function check(server: ReferenceServer, opts: Partial<CheckOptions> = {}): Promise<CheckReport> {
  return runCheck({
    url: server.url,
    profile: server.profile.name,
    headers: AUTH,
    allowLoopback: true,
    deliveryWaitMs: 3000,
    streamWatchMs: 3000,
    heartbeatMs: 250,
    settleMs: 300,
    ...opts,
  });
}

export function rule(report: CheckReport, id: string): RuleResult {
  const r = report.results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r;
}

/** Results that are neither pass, skip nor info. */
export function flagged(report: CheckReport): RuleResult[] {
  return report.results.filter((r) => r.status === "fail" || r.status === "warn");
}

export function describeFlagged(report: CheckReport): string {
  return flagged(report)
    .map((r) => `${r.id}=${r.status}: ${r.detail}`)
    .join("\n");
}

/** Capture what a command writes. */
export function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: { write: (s: string) => out.push(s), isTTY: false },
      err: { write: (s: string) => err.push(s), isTTY: false },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** A tiny HTTP server with a custom handler, for transports and edge cases. */
export async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; port: number; server: Server; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}
