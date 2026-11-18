/**
 * `hookbench check`: grade an MCP server's Events implementation against SEP-3415 (or the
 * ChatGPT dialect). Deterministic: every probe is a fixed request with a fixed expectation,
 * and a rule that cannot be observed is skipped with the reason, never guessed.
 */
import { HttpError, McpEventsClient, type Discovery } from "../client/client.js";
import { TransportError } from "../client/transport.js";
import {
  CALLBACK_ERROR_REASONS,
  ERROR,
  LEGACY_EVENT_ERROR,
  MAX_DELIVERY_BYTES,
  META,
  METHODS,
  NOTIFICATIONS,
} from "../protocol/constants.js";
import { errorName, isFailure, isObject, RpcError, type JsonRpcMessage } from "../protocol/jsonrpc.js";
import { getProfile, type Profile, type ProfileName } from "../protocol/profiles.js";
import { invalidArguments, sampleFromSchema } from "../protocol/schema-lite.js";
import type { DeliveryMode, EventDescriptor, JsonObject, ListEventsResult, PollResult, SubscribeResult } from "../protocol/types.js";
import { occurrenceProblems, WebhookReceiver, type ReceivedDelivery } from "../receiver/receiver.js";
import { TOOL_NAME, VERSION } from "../version.js";
import { generateSecret } from "../webhooks/standard-webhooks.js";
import { RULES, type Level, type RuleDef, type Status } from "./rules.js";

export interface CheckOptions {
  url: string;
  profile?: ProfileName;
  headers?: Record<string, string>;
  /** Public https URL forwarding to Hookbench's local receiver; enables the delivery rules on strict servers. */
  callbackUrl?: string;
  /** The server is configured to accept loopback callbacks (dev mode): skip the private-address rule. */
  allowLoopback?: boolean;
  /** POST {name, data} here to make the server emit an event. */
  triggerUrl?: string;
  /** Or a function that makes the server emit an event. */
  trigger?: (name: string, data: JsonObject) => Promise<void>;
  receiverPort?: number;
  timeoutMs?: number;
  /** How long to wait for an event after triggering one. */
  deliveryWaitMs?: number;
  /** Longest a push stream is watched for heartbeats. */
  streamWatchMs?: number;
  progress?: (line: string) => void;
}

export interface RuleResult {
  id: string;
  title: string;
  level: Level;
  group: RuleDef["group"];
  status: Status;
  detail: string;
  reference: string;
}

export interface CheckReport {
  tool: { name: string; version: string };
  target: string;
  profile: ProfileName;
  startedAt: string;
  durationMs: number;
  server?: { name?: string; version?: string; era?: string; protocolVersion?: string; capabilityKey?: string };
  trigger?: string;
  callback?: string;
  results: RuleResult[];
  summary: Record<Status, number>;
  /** No MUST failed. */
  passed: boolean;
}

class Results {
  private readonly map = new Map<string, { status: Status; detail: string }>();

  set(id: string, status: Status, detail: string): void {
    this.map.set(id, { status, detail });
  }
  pass(id: string, detail: string): void {
    this.set(id, "pass", detail);
  }
  skip(id: string, detail: string): void {
    if (!this.map.has(id)) this.set(id, "skip", detail);
  }
  info(id: string, detail: string): void {
    this.set(id, "info", detail);
  }
  /** A violation, graded by the rule's level: MUST fails, SHOULD warns, INTEROP informs. */
  violate(id: string, detail: string): void {
    const level = RULES.find((r) => r.id === id)?.level ?? "MUST";
    this.set(id, level === "MUST" ? "fail" : level === "SHOULD" ? "warn" : "info", detail);
  }
  warn(id: string, detail: string): void {
    this.set(id, "warn", detail);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  status(id: string): Status | undefined {
    return this.map.get(id)?.status;
  }
  skipAll(ids: string[], detail: string): void {
    for (const id of ids) this.skip(id, detail);
  }
  final(): RuleResult[] {
    return RULES.map((r) => {
      const got = this.map.get(r.id) ?? { status: "skip" as Status, detail: "not run" };
      return { id: r.id, title: r.title, level: r.level, group: r.group, reference: r.reference, ...got };
    });
  }
}

function describe(err: unknown): string {
  if (err instanceof RpcError) return `${errorName(err.code)} (${err.code}): ${err.message.replace(/^[^:]+: /, "")}`;
  if (err instanceof HttpError || err instanceof TransportError) return err.message;
  return (err as Error)?.message ?? String(err);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Check an error against the code a profile expects for it. */
function expectError(err: unknown, name: keyof Profile["errors"] | "InvalidParams", profile: Profile): { ok: boolean; detail: string } {
  if (!(err instanceof RpcError)) return { ok: false, detail: `expected a JSON-RPC ${name} error, got ${describe(err)}` };
  const want = name === "InvalidParams" ? ERROR.InvalidParams : profile.errors[name];
  if (err.code === want) return { ok: true, detail: `${describe(err)}` };
  if (!profile.strictErrorCodes && name !== "CallbackEndpointError") return { ok: true, detail: `${describe(err)} (the ${profile.name} profile does not pin this code)` };
  const legacy = name !== "InvalidParams" ? LEGACY_EVENT_ERROR[name] : undefined;
  if (legacy !== undefined && err.code === legacy) {
    return { ok: false, detail: `got ${err.code}, the design sketch's pre-2026-10-08 numbering; SEP-3415 uses ${name} (${want})` };
  }
  return { ok: false, detail: `got ${describe(err)}; expected ${name} (${want})` };
}

function isForbidden(err: unknown, profile: Profile): boolean {
  return err instanceof RpcError && (err.code === profile.errors.Forbidden || err.code === ERROR.Forbidden || err.code === LEGACY_EVENT_ERROR.Forbidden);
}

function isCallbackError(err: unknown, profile: Profile): boolean {
  return err instanceof RpcError && (err.code === profile.errors.CallbackEndpointError || err.code === ERROR.CallbackEndpointError || err.code === LEGACY_EVENT_ERROR.CallbackEndpointError);
}

export async function runCheck(opts: CheckOptions): Promise<CheckReport> {
  const started = Date.now();
  const profile = getProfile(opts.profile);
  const progress = opts.progress ?? (() => {});
  const results = new Results();
  const client = new McpEventsClient({ url: opts.url, headers: opts.headers, timeoutMs: opts.timeoutMs ?? 10_000 });
  const deliveryWait = opts.deliveryWaitMs ?? 5000;
  const streamWatch = opts.streamWatchMs ?? 5000;
  const report = (): CheckReport => {
    const final = results.final();
    const summary: Record<Status, number> = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
    for (const r of final) summary[r.status]++;
    return {
      tool: { name: TOOL_NAME, version: VERSION },
      target: opts.url,
      profile: profile.name,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      server: discovery
        ? {
            name: discovery.serverInfo?.name,
            version: discovery.serverInfo?.version,
            era: discovery.era,
            protocolVersion: discovery.protocolVersion,
            capabilityKey: discovery.capabilityKey,
          }
        : undefined,
      trigger: triggerLabel,
      callback: callbackLabel,
      results: final,
      summary,
      passed: summary.fail === 0,
    };
  };
  const allIds = RULES.map((r) => r.id);
  let discovery: Discovery | undefined;
  let triggerLabel: string | undefined;
  let callbackLabel: string | undefined;

  // ---------- trigger ----------
  let triggerUrl = opts.triggerUrl;
  if (!opts.trigger && !triggerUrl) {
    try {
      const origin = new URL(opts.url).origin;
      const res = await fetch(`${origin}/hookbench`, { signal: AbortSignal.timeout(1500) });
      const body = res.ok ? ((await res.json()) as JsonObject) : {};
      if (body["name"] === "hookbench-reference") triggerUrl = `${origin}/hookbench/fire`;
    } catch {
      // not a Hookbench reference server; events can still arrive on their own
    }
  }
  const trigger =
    opts.trigger ??
    (triggerUrl
      ? async (name: string, data: JsonObject) => {
          const res = await fetch(triggerUrl as string, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, data }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`trigger answered HTTP ${res.status}`);
        }
      : undefined);
  triggerLabel = opts.trigger ? "custom trigger" : triggerUrl;
  const noTrigger = "no event arrived to inspect; pass --trigger-url so Hookbench can make the server emit one";
  const fire = async (desc: EventDescriptor): Promise<boolean> => {
    if (!trigger) return false;
    const data = sampleFromSchema(desc.payloadSchema);
    try {
      await trigger(desc.name, isObject(data) ? data : {});
      return true;
    } catch (err) {
      progress(`trigger failed for ${desc.name}: ${(err as Error).message}`);
      return false;
    }
  };

  // ---------- discovery ----------
  progress("server/discover");
  const disc = await attempt(() => client.discover());
  if (!disc.ok) {
    results.violate("discover.responds", `could not discover the server: ${describe(disc.error)}`);
    results.skipAll(allIds, "the server could not be discovered");
    return report();
  }
  discovery = disc.value;
  if (discovery.era === "legacy") {
    if (profile.name === "sep-3415") {
      results.violate("discover.responds", `the server only speaks the initialize handshake (${discovery.fallbackReason}); SEP-3415 is defined for protocol 2026-07-28, where servers MUST implement server/discover`);
    } else {
      results.pass("discover.responds", `initialize handshake on ${discovery.protocolVersion} (${discovery.fallbackReason}); OpenAI's guide accepts this path`);
    }
    if (profile.resultType) results.skip("discover.result-type", "initialize results predate resultType");
  } else {
    results.pass("discover.responds", `protocol ${discovery.protocolVersion}, server ${discovery.serverInfo?.name ?? "(no serverInfo)"}${discovery.serverInfo?.version ? ` ${discovery.serverInfo.version}` : ""}`);
  }
  if (discovery.era === "modern") {
    if (discovery.resultType === "complete") results.pass("discover.result-type", 'server/discover result has resultType: "complete"');
    else if (!profile.resultType) results.skip("discover.result-type", `the ${profile.name} profile does not require resultType`);
    else results.violate("discover.result-type", discovery.resultType === undefined ? "server/discover result has no resultType; every 2026-07-28 result MUST carry one" : `resultType is ${JSON.stringify(discovery.resultType)}, expected "complete"`);
  }

  const key = discovery.capabilityKey;
  const settings = discovery.eventsSettings;
  const settingsProblem = settings && "listChanged" in settings && typeof settings["listChanged"] !== "boolean" ? "; listChanged must be a boolean" : "";
  if (key === "none") {
    results.violate("capability.declared", 'no capabilities.extensions["io.modelcontextprotocol/events"] (SEP-3415) and no capabilities.events (ChatGPT); clients MUST NOT send events/* to this server');
    results.skipAll(allIds, "the server does not advertise MCP Events");
    return report();
  }
  if (profile.capability === "extensions") {
    if (key === "top-level") results.violate("capability.declared", 'advertised under the top-level capabilities.events key from the design sketch; SEP-3415 puts it in capabilities.extensions["io.modelcontextprotocol/events"]');
    else if (settingsProblem) results.violate("capability.declared", `advertised${settingsProblem}`);
    else results.pass("capability.declared", `capabilities.extensions["io.modelcontextprotocol/events"] = ${JSON.stringify(settings ?? {})}${key === "both" ? " (also under capabilities.events)" : ""}`);
  } else {
    if (key === "extensions") results.violate("capability.declared", 'advertised only in capabilities.extensions; ChatGPT reads the top-level capabilities.events key');
    else results.pass("capability.declared", `capabilities.events = ${JSON.stringify(isObject(discovery.capabilities["events"]) ? discovery.capabilities["events"] : {})}`);
  }

  // ---------- events/list ----------
  progress("events/list");
  const first = await attempt(() => client.call<ListEventsResult>(METHODS.list, {}));
  if (!first.ok) {
    results.violate("list.result", `events/list failed: ${describe(first.error)}`);
    results.skipAll(allIds, "events/list failed");
    return report();
  }
  const pages: ListEventsResult[] = [first.value];
  const pageProblems: string[] = [];
  const checkPage = (page: ListEventsResult, n: number) => {
    if (!Array.isArray(page.events)) pageProblems.push(`page ${n}: events is ${page.events === undefined ? "missing" : typeof page.events}, not an array`);
    if (profile.resultType && discovery?.era === "modern" && page.resultType !== "complete") pageProblems.push(`page ${n}: resultType is ${JSON.stringify(page.resultType)}, expected "complete"`);
  };
  checkPage(first.value, 1);
  let cursor = first.value.nextCursor;
  let pagination = "one page, no nextCursor";
  const seenCursors = new Set<string>();
  for (let n = 2; cursor !== undefined && n <= 50; n++) {
    if (typeof cursor !== "string" || cursor.length === 0) {
      results.violate("list.pagination", `nextCursor is ${JSON.stringify(cursor)}; it must be a non-empty string when present`);
      break;
    }
    if (seenCursors.has(cursor)) {
      results.violate("list.pagination", `nextCursor ${JSON.stringify(cursor)} repeats; the list never ends`);
      break;
    }
    seenCursors.add(cursor);
    const page = await attempt(() => client.call<ListEventsResult>(METHODS.list, { cursor }));
    if (!page.ok) {
      results.violate("list.pagination", `events/list with nextCursor ${JSON.stringify(cursor)} failed: ${describe(page.error)}`);
      break;
    }
    pages.push(page.value);
    checkPage(page.value, n);
    pagination = `${pages.length} pages`;
    cursor = page.value.nextCursor;
  }
  if (!results.has("list.pagination")) results.pass("list.pagination", pagination);
  if (pageProblems.length > 0) results.violate("list.result", pageProblems.slice(0, 3).join("; "));
  else results.pass("list.result", `${pages.reduce((n, p) => n + (Array.isArray(p.events) ? p.events.length : 0), 0)} event type(s)${profile.resultType ? ', resultType "complete"' : ""}`);

  const raw = pages.flatMap((p) => (Array.isArray(p.events) ? p.events : []));
  const descProblems: string[] = [];
  const names = new Set<string>();
  const events: EventDescriptor[] = [];
  for (const [i, d] of raw.entries()) {
    const label = isObject(d) && typeof d.name === "string" ? d.name : `#${i + 1}`;
    const before = descProblems.length;
    if (!isObject(d)) {
      descProblems.push(`${label}: not an object`);
      continue;
    }
    if (typeof d.name !== "string" || d.name.length === 0) descProblems.push(`${label}: name is missing`);
    else if (names.has(d.name)) descProblems.push(`${label}: listed twice`);
    else names.add(d.name);
    const delivery = (d as { delivery?: unknown }).delivery;
    if (!Array.isArray(delivery) || delivery.length === 0) descProblems.push(`${label}: delivery must be a non-empty array`);
    else {
      const bad = delivery.filter((m) => m !== "poll" && m !== "push" && m !== "webhook");
      if (bad.length > 0) descProblems.push(`${label}: unknown delivery mode ${JSON.stringify(bad[0])}`);
      if (new Set(delivery).size !== delivery.length) descProblems.push(`${label}: delivery lists a mode twice`);
    }
    if (!isObject((d as { inputSchema?: unknown }).inputSchema)) descProblems.push(`${label}: inputSchema is missing or not an object`);
    if (!isObject((d as { payloadSchema?: unknown }).payloadSchema)) descProblems.push(`${label}: payloadSchema is missing or not an object`);
    if ("description" in d && typeof d.description !== "string") descProblems.push(`${label}: description must be a string`);
    if (descProblems.length === before) events.push(d);
  }
  if (profile.name === "chatgpt" && events.length > 0 && !events.some((e) => e.delivery.includes("webhook"))) {
    descProblems.push("no event type offers webhook delivery, the only mode ChatGPT uses");
  }
  if (raw.length === 0) results.warn("list.descriptors", "events/list returned no event types, so there is nothing to subscribe to");
  else if (descProblems.length > 0) results.violate("list.descriptors", descProblems.slice(0, 4).join("; "));
  else results.pass("list.descriptors", events.map((e) => `${e.name} [${e.delivery.join(", ")}]`).join("; "));
  client.rememberSchemas(events);

  const usable = (m: DeliveryMode) => (profile.modes.includes(m) ? events.find((e) => e.delivery.includes(m)) : undefined);
  const pollTarget = usable("poll");
  const pushTarget = usable("push");
  const webhookTarget = usable("webhook");

  if (!pollTarget) results.skipAll(["poll.bootstrap", "poll.result-fields", "poll.resume", "poll.occurrence"], profile.modes.includes("poll") ? "no event type offers poll delivery" : `the ${profile.name} profile does not use poll`);
  if (!pushTarget) results.skipAll(["stream.active", "stream.subscription-id", "stream.heartbeat", "stream.occurrence"], profile.modes.includes("push") ? "no event type offers push delivery" : `the ${profile.name} profile does not use push`);
  const webhookIds = RULES.filter((r) => r.group === "webhook" || r.group === "delivery").map((r) => r.id);
  if (!webhookTarget) results.skipAll(webhookIds, "no event type offers webhook delivery");

  // A request that names an event, in whichever mode the server offers.
  const callback = (path: string) => `https://hookbench-check.invalid/${path}`;
  const named = async (mode: DeliveryMode, name: string, args: JsonObject, extra: { headers?: Record<string, string | null> } = {}) => {
    const o = { overrideHeaders: extra.headers };
    if (mode === "poll") return client.call<PollResult>(METHODS.poll, { name, arguments: args, cursor: null }, o);
    if (mode === "push") {
      const { stream } = await client.openStream({ name, arguments: args, cursor: null, heartbeatMs: 1000 }, o);
      stream.close();
      if (stream.response && isFailure(stream.response)) throw new RpcError(stream.response.error, stream.status);
      if (stream.contentType.includes("text/event-stream")) return { opened: true };
      throw new HttpError(`HTTP ${stream.status} without a JSON-RPC response`, stream.status, stream.bodyText);
    }
    return client.call<SubscribeResult>(METHODS.subscribe, {
      name,
      arguments: args,
      delivery: { mode: "webhook", url: callback("probe"), secret: generateSecret() },
      cursor: null,
    }, o);
  };
  const anyMode: DeliveryMode | undefined = pollTarget ? "poll" : pushTarget ? "push" : webhookTarget ? "webhook" : undefined;
  const anyTarget = pollTarget ?? pushTarget ?? webhookTarget;

  // ---------- errors ----------
  progress("error handling");
  if (anyMode) {
    const r = await attempt(() => named(anyMode, "hookbench.no-such-event", {}));
    if (r.ok) results.violate("error.unknown-event", `events/${anyMode === "push" ? "stream" : anyMode === "webhook" ? "subscribe" : "poll"} for an unknown event name succeeded`);
    else if (anyMode === "webhook" && isForbidden(r.error, profile)) results.skip("error.unknown-event", "the server answered Forbidden first; pass --header with credentials to test this");
    else {
      const e = expectError(r.error, "NotFound", profile);
      if (e.ok) results.pass("error.unknown-event", e.detail);
      else results.violate("error.unknown-event", e.detail);
    }
  } else results.skip("error.unknown-event", "no usable delivery mode");

  let unsupported: { desc: EventDescriptor; mode: DeliveryMode } | undefined;
  for (const d of events) {
    const missing = profile.modes.find((m) => !d.delivery.includes(m));
    if (missing) {
      unsupported = { desc: d, mode: missing };
      break;
    }
  }
  if (unsupported) {
    const { desc, mode } = unsupported;
    const r = await attempt(() => named(mode, desc.name, {}));
    if (r.ok) results.violate("error.unsupported-mode", `${desc.name} lists [${desc.delivery.join(", ")}], yet ${mode} delivery was accepted`);
    else if (mode === "webhook" && isForbidden(r.error, profile)) results.skip("error.unsupported-mode", "the server answered Forbidden first; pass --header with credentials to test this");
    else {
      const e = expectError(r.error, "Unsupported", profile);
      if (e.ok) results.pass("error.unsupported-mode", `${mode} on ${desc.name}: ${e.detail}`);
      else results.violate("error.unsupported-mode", `${mode} on ${desc.name}: ${e.detail}`);
    }
  } else results.skip("error.unsupported-mode", "every event type offers every mode this profile uses");

  const invalidTarget = events.map((d) => ({ d, bad: invalidArguments(d.inputSchema) })).find((x) => x.bad && x.d.delivery.some((m) => profile.modes.includes(m)));
  if (invalidTarget && invalidTarget.bad) {
    const mode = (["poll", "push", "webhook"] as DeliveryMode[]).find((m) => invalidTarget.d.delivery.includes(m) && profile.modes.includes(m)) as DeliveryMode;
    const r = await attempt(() => named(mode, invalidTarget.d.name, invalidTarget.bad?.args ?? {}));
    if (r.ok) results.violate("error.invalid-arguments", `${invalidTarget.d.name} accepted arguments with ${invalidTarget.bad.why}`);
    else if (mode === "webhook" && isForbidden(r.error, profile)) results.skip("error.invalid-arguments", "the server answered Forbidden first; pass --header with credentials to test this");
    else if (r.error instanceof RpcError && r.error.code === ERROR.HeaderMismatch) results.skip("error.invalid-arguments", "the invalid argument also broke an Mcp-Param header, so the server answered HeaderMismatch first");
    else {
      const e = expectError(r.error, "InvalidParams", profile);
      if (e.ok) results.pass("error.invalid-arguments", `${invalidTarget.d.name} with ${invalidTarget.bad.why}: ${e.detail}`);
      else results.violate("error.invalid-arguments", `${invalidTarget.d.name} with ${invalidTarget.bad.why}: ${e.detail}`);
    }
  } else results.skip("error.invalid-arguments", "no inputSchema has a typed property Hookbench can break");

  if (discovery.era !== "modern") results.skip("headers.mcp-name", "the routing headers belong to protocol 2026-07-28; this server uses an older revision");
  else if (anyMode && anyTarget) {
    const failures: string[] = [];
    for (const [label, value] of [["a wrong Mcp-Name", "hookbench-mismatch"], ["no Mcp-Name", null]] as const) {
      const sent = await attempt(async () => {
        if (anyMode === "poll" || anyMode === "webhook") {
          const s = await client.send(anyMode === "poll" ? METHODS.poll : METHODS.subscribe, anyMode === "poll"
            ? { name: anyTarget.name, arguments: {}, cursor: null }
            : { name: anyTarget.name, arguments: {}, delivery: { mode: "webhook", url: callback("mcp-name"), secret: generateSecret() } }, { overrideHeaders: { "mcp-name": value } });
          return { status: s.status, error: s.response && isFailure(s.response) ? s.response.error : undefined };
        }
        const { stream } = await client.openStream({ name: anyTarget.name, arguments: {}, cursor: null }, { overrideHeaders: { "mcp-name": value } });
        stream.close();
        return { status: stream.status, error: stream.response && isFailure(stream.response) ? stream.response.error : undefined };
      });
      if (!sent.ok) failures.push(`${label}: ${describe(sent.error)}`);
      else if (sent.value.status !== 400 || sent.value.error?.code !== ERROR.HeaderMismatch) {
        failures.push(`${label}: got HTTP ${sent.value.status}${sent.value.error ? ` with ${errorName(sent.value.error.code)} (${sent.value.error.code})` : " and no JSON-RPC error"}, expected 400 with HeaderMismatch (-32020)`);
      }
    }
    if (failures.length > 0) results.violate("headers.mcp-name", failures.join("; "));
    else results.pass("headers.mcp-name", "wrong and missing Mcp-Name both got 400 HeaderMismatch (-32020)");
  } else results.skip("headers.mcp-name", "no usable delivery mode");

  // ---------- poll ----------
  if (pollTarget) {
    progress(`events/poll ${pollTarget.name}`);
    const boot = await attempt(() => client.poll({ name: pollTarget.name, arguments: {}, cursor: null }));
    if (!boot.ok) {
      results.violate("poll.bootstrap", `events/poll with cursor null failed: ${describe(boot.error)}`);
      results.skipAll(["poll.result-fields", "poll.resume", "poll.occurrence"], "the bootstrap poll failed");
    } else {
      const b = boot.value;
      const problems: string[] = [];
      if (!Array.isArray(b.events)) problems.push("events is not an array");
      else if (b.events.length > 0) problems.push(`returned ${b.events.length} past event(s); cursor null means "start from now" and returns none`);
      if ("cursor" in b && b.cursor !== null && typeof b.cursor !== "string") problems.push("cursor must be a string or null");
      if (profile.resultType && discovery.era === "modern" && b.resultType !== "complete") problems.push(`resultType is ${JSON.stringify(b.resultType)}`);
      if (problems.length > 0) results.violate("poll.bootstrap", problems.join("; "));
      else results.pass("poll.bootstrap", `no events, cursor ${JSON.stringify(b.cursor ?? null)}`);

      const fieldProblems: string[] = [];
      if (typeof b.truncated !== "boolean") fieldProblems.push("truncated");
      if (typeof b.hasMore !== "boolean") fieldProblems.push("hasMore");
      if (typeof b.nextPollMs !== "number" || b.nextPollMs < 0) fieldProblems.push("nextPollMs");
      if (fieldProblems.length > 0) results.violate("poll.result-fields", `missing or mistyped: ${fieldProblems.join(", ")} (clients fall back to guessing the interval)`);
      else results.pass("poll.result-fields", `truncated ${b.truncated}, hasMore ${b.hasMore}, nextPollMs ${b.nextPollMs}`);

      const fired = await fire(pollTarget);
      if (fired) await sleep(150);
      const resume = await attempt(() => client.poll({ name: pollTarget.name, arguments: {}, cursor: b.cursor ?? null }));
      if (!resume.ok) {
        results.violate("poll.resume", `events/poll with the cursor it returned (${JSON.stringify(b.cursor ?? null)}) failed: ${describe(resume.error)}`);
        results.skip("poll.occurrence", "the resume poll failed");
      } else {
        results.pass("poll.resume", `cursor ${JSON.stringify(b.cursor ?? null)} -> ${JSON.stringify(resume.value.cursor ?? null)}`);
        const got = Array.isArray(resume.value.events) ? resume.value.events : [];
        if (got.length === 0) {
          results.skip("poll.occurrence", b.cursor === null || b.cursor === undefined ? "this event type has no replay (cursor null), so polling cannot return past events" : fired ? "the trigger fired but the poll returned no events" : noTrigger);
        } else {
          const problems = got.flatMap((e, i) => occurrenceProblems(e, pollTarget.name, pollTarget.payloadSchema).map((p) => `event ${i + 1}: ${p}`));
          if (problems.length > 0) results.violate("poll.occurrence", problems.slice(0, 3).join("; "));
          else results.pass("poll.occurrence", `${got.length} event(s) with eventId, name, timestamp and data matching payloadSchema`);
        }
      }
    }
  }

  // ---------- push ----------
  if (pushTarget) {
    progress(`events/stream ${pushTarget.name}`);
    const opened = await attempt(() => client.openStream({ name: pushTarget.name, arguments: {}, cursor: null, heartbeatMs: 1000 }, { connectTimeoutMs: opts.timeoutMs ?? 10_000 }));
    if (!opened.ok) {
      results.violate("stream.active", `events/stream failed: ${describe(opened.error)}`);
      results.skipAll(["stream.subscription-id", "stream.heartbeat", "stream.occurrence"], "the stream did not open");
    } else {
      const { stream, requestId } = opened.value;
      if (stream.response || !stream.contentType.includes("text/event-stream")) {
        const r = stream.response;
        results.violate("stream.active", r && isFailure(r) ? `events/stream answered with an error: ${errorName(r.error.code)} (${r.error.code}) ${r.error.message}` : `events/stream answered HTTP ${stream.status} ${stream.contentType || "(no content type)"} instead of an SSE stream`);
        results.skipAll(["stream.subscription-id", "stream.heartbeat", "stream.occurrence"], "the stream did not open");
      } else {
        const messages: Array<{ at: number; m: JsonRpcMessage }> = [];
        const reader = (async () => {
          for await (const m of stream.messages) messages.push({ at: Date.now(), m });
        })().catch(() => {});
        const openedAt = Date.now();
        // Wait for the first message.
        while (messages.length === 0 && Date.now() - openedAt < 3000) await sleep(25);
        const firstMsg = messages[0]?.m as { method?: string; params?: JsonObject } | undefined;
        let granted = 30_000;
        if (!firstMsg) results.violate("stream.active", "the stream opened but sent nothing within 3 s; it must start with notifications/events/active");
        else if (firstMsg.method !== NOTIFICATIONS.active) results.violate("stream.active", `the first message was ${firstMsg.method ?? "a response"}, not notifications/events/active`);
        else {
          const p = isObject(firstMsg.params) ? firstMsg.params : {};
          if (profile.name === "sep-3415" && typeof p["heartbeatMs"] !== "number") results.violate("stream.active", "notifications/events/active has no heartbeatMs; SEP-3415 says it carries the granted heartbeat interval");
          else {
            if (typeof p["heartbeatMs"] === "number") granted = p["heartbeatMs"];
            results.pass("stream.active", `notifications/events/active: cursor ${JSON.stringify(p["cursor"] ?? null)}, truncated ${String(p["truncated"])}, heartbeatMs ${String(p["heartbeatMs"])}`);
          }
        }
        const fired = await fire(pushTarget);
        const window = Math.min(Math.round(granted * 2.2), streamWatch);
        const deadline = openedAt + Math.max(window, fired ? 1200 : 0);
        while (Date.now() < deadline) {
          await sleep(50);
          if (fired && messages.some((x) => (x.m as { method?: string }).method === NOTIFICATIONS.event) && Date.now() > openedAt + window) break;
        }
        stream.close();
        await reader;

        const eventsSeen = messages.filter((x) => typeof (x.m as { method?: unknown }).method === "string" && (x.m as { method: string }).method.startsWith("notifications/events/"));
        const badIds = eventsSeen.filter((x) => {
          const p = (x.m as { params?: JsonObject }).params;
          const meta = isObject(p) && isObject(p["_meta"]) ? (p["_meta"] as JsonObject) : {};
          return meta[META.subscriptionId] !== requestId;
        });
        if (eventsSeen.length === 0) results.skip("stream.subscription-id", "no notifications arrived");
        else if (badIds.length > 0) {
          const p = (badIds[0]?.m as { method?: string; params?: JsonObject }) ?? {};
          const meta = isObject(p.params) && isObject(p.params["_meta"]) ? (p.params["_meta"] as JsonObject) : {};
          results.violate("stream.subscription-id", `${badIds.length} of ${eventsSeen.length} notification(s) lack _meta["${META.subscriptionId}"] = ${JSON.stringify(requestId)} (first: ${p.method} carried ${JSON.stringify(meta[META.subscriptionId])})`);
        } else results.pass("stream.subscription-id", `${eventsSeen.length} notification(s) tagged with the request id ${JSON.stringify(requestId)}`);

        const heartbeats = eventsSeen.filter((x) => (x.m as { method?: string }).method === NOTIFICATIONS.heartbeat);
        if (granted * 1.5 > streamWatch) results.skip("stream.heartbeat", `the server granted heartbeatMs ${granted}; watching that long is beyond --stream-watch ${streamWatch} ms`);
        else {
          let maxGap = 0;
          let prev = openedAt;
          for (const x of messages) {
            maxGap = Math.max(maxGap, x.at - prev);
            prev = x.at;
          }
          maxGap = Math.max(maxGap, Math.min(Date.now(), deadline) - prev);
          if (heartbeats.length === 0) results.violate("stream.heartbeat", `no notifications/events/heartbeat in ${window} ms with heartbeatMs ${granted}; the server MUST send one whenever heartbeatMs passes quietly`);
          else if (maxGap > granted * 1.5 + 300) results.violate("stream.heartbeat", `the stream was silent for ${maxGap} ms with heartbeatMs ${granted}`);
          else results.pass("stream.heartbeat", `${heartbeats.length} heartbeat(s) in ${window} ms, longest silence ${maxGap} ms (heartbeatMs ${granted})`);
        }

        const occurrences = eventsSeen.filter((x) => (x.m as { method?: string }).method === NOTIFICATIONS.event);
        if (occurrences.length === 0) results.skip("stream.occurrence", fired ? "the trigger fired but no notifications/events/event arrived" : noTrigger);
        else {
          const problems = occurrences.flatMap((x, i) => {
            const p = { ...(((x.m as { params?: JsonObject }).params ?? {}) as JsonObject) };
            delete p["_meta"];
            return occurrenceProblems(p, pushTarget.name, pushTarget.payloadSchema).map((pr) => `event ${i + 1}: ${pr}`);
          });
          if (problems.length > 0) results.violate("stream.occurrence", problems.slice(0, 3).join("; "));
          else results.pass("stream.occurrence", `${occurrences.length} event(s) with eventId, name, timestamp, data and cursor`);
        }
      }
    }
  }

  // ---------- webhook ----------
  let observedWebhookId: "independent" | "event-id" | undefined;
  if (webhookTarget) {
    progress(`events/subscribe ${webhookTarget.name}`);
    const t = webhookTarget;
    const hasCredentials = Object.keys(opts.headers ?? {}).some((h) => h.toLowerCase() === "authorization" || h.toLowerCase() === "cookie" || h.toLowerCase().includes("api-key") || h.toLowerCase().includes("token"));
    const subscribeTo = (url: string, extra: Partial<{ secret: string; withoutAuth: boolean; ttlMs: number }> = {}) =>
      client.call<SubscribeResult>(METHODS.subscribe, {
        name: t.name,
        arguments: {},
        delivery: { mode: "webhook", url, secret: extra.secret ?? generateSecret() },
        cursor: null,
        ...(extra.ttlMs !== undefined ? { ttlMs: extra.ttlMs } : {}),
      }, { withoutConfiguredHeaders: extra.withoutAuth });
    const cleanup = async (url: string, withoutAuth = false) => {
      await attempt(() => client.call(METHODS.unsubscribe, { name: t.name, arguments: {}, delivery: { mode: "webhook", url } }, { withoutConfiguredHeaders: withoutAuth }));
    };

    // Authentication.
    const unauth = await attempt(() => subscribeTo(callback("unauthenticated"), { withoutAuth: true }));
    let authBlocked = false;
    if (unauth.ok) {
      results.violate("subscribe.requires-auth", "an unauthenticated caller created a webhook subscription; webhook mode needs an authenticated principal");
      await cleanup(callback("unauthenticated"), true);
    } else if (isForbidden(unauth.error, profile)) {
      results.pass("subscribe.requires-auth", describe(unauth.error));
      authBlocked = !hasCredentials;
    } else if (unauth.error instanceof HttpError && (unauth.error.status === 401 || unauth.error.status === 403)) {
      results.pass("subscribe.requires-auth", `rejected at the HTTP layer with ${unauth.error.status}`);
      authBlocked = !hasCredentials;
    } else if (isCallbackError(unauth.error, profile)) {
      results.warn("subscribe.requires-auth", `the server tried to verify the callback for an unauthenticated caller (${describe(unauth.error)}); it should answer Forbidden before doing any work`);
    } else {
      results.violate("subscribe.requires-auth", `expected Forbidden, got ${describe(unauth.error)}`);
    }
    const needAuth = 'the server needs credentials for webhook mode: pass --header "Authorization: Bearer <token>"';
    if (authBlocked) {
      results.skipAll(webhookIds.filter((id) => id !== "subscribe.requires-auth"), needAuth);
    } else {
      const rejectedAsInvalid = async (id: string, url: string, secret: string | undefined, what: string) => {
        const r = await attempt(() => subscribeTo(url, secret ? { secret } : {}));
        if (r.ok) {
          results.violate(id, `${what} was accepted`);
          await cleanup(url);
        } else if (isForbidden(r.error, profile)) results.skip(id, needAuth);
        else if (isCallbackError(r.error, profile)) results.violate(id, `${what} was not rejected up front: the server tried to contact the callback (${describe(r.error)})`);
        else {
          const e = expectError(r.error, "InvalidParams", profile);
          if (e.ok) results.pass(id, `${what}: ${e.detail}`);
          else results.violate(id, `${what}: ${e.detail}`);
        }
      };
      await rejectedAsInvalid("subscribe.rejects-http", "http://hookbench-check.example.com/hook", undefined, "an http:// callback");
      const badSecrets = ["whsec_dG9vLXNob3J0", "not-a-whsec-secret"];
      await rejectedAsInvalid("subscribe.rejects-bad-secret", callback("bad-secret"), badSecrets[0], `secret "${badSecrets[0]}" (9 bytes)`);
      if (results.status("subscribe.rejects-bad-secret") === "pass") {
        const second = await attempt(() => subscribeTo(callback("bad-secret-2"), { secret: badSecrets[1] }));
        if (second.ok) {
          results.violate("subscribe.rejects-bad-secret", `secret "${badSecrets[1]}" (no whsec_ prefix) was accepted`);
          await cleanup(callback("bad-secret-2"));
        }
      }

      if (opts.allowLoopback) results.skip("subscribe.rejects-private", "skipped: --allow-loopback says this server accepts loopback callbacks on purpose");
      else {
        const r = await attempt(() => subscribeTo("https://127.0.0.1:9/hookbench-check"));
        if (r.ok) {
          results.violate("subscribe.rejects-private", "a callback on 127.0.0.1 was accepted; servers SHOULD refuse non-public addresses");
          await cleanup("https://127.0.0.1:9/hookbench-check");
        } else if (isCallbackError(r.error, profile)) {
          results.violate("subscribe.rejects-private", `the server tried to connect to 127.0.0.1 (${describe(r.error)}); it SHOULD refuse non-public addresses before connecting`);
        } else results.pass("subscribe.rejects-private", `refused: ${describe(r.error)}`);
      }

      // Verification, part 1: an endpoint that cannot answer the handshake.
      const verifyNotes: string[] = [];
      let verifyFail: string | undefined;
      const unreachable = await attempt(() => subscribeTo(callback("unreachable")));
      if (unreachable.ok) {
        verifyFail = "a callback that cannot answer (an .invalid host) was subscribed; a server MUST NOT activate delivery before the endpoint confirms intent";
        await cleanup(callback("unreachable"));
      } else if (isCallbackError(unreachable.error, profile)) {
        const data = isObject(unreachable.error instanceof RpcError ? unreachable.error.data : undefined) ? ((unreachable.error as RpcError).data as JsonObject) : {};
        const reason = data["reason"];
        if (typeof reason !== "string" || !(CALLBACK_ERROR_REASONS as readonly string[]).includes(reason)) {
          verifyFail = `CallbackEndpointError data.reason is ${JSON.stringify(reason)}; it must be one of ${CALLBACK_ERROR_REASONS.join(", ")}`;
        } else {
          const e = expectError(unreachable.error, "CallbackEndpointError", profile);
          if (!e.ok) verifyFail = `unreachable callback: ${e.detail}`;
          else verifyNotes.push(`unreachable callback refused with ${e.detail.split(":")[0]} (reason ${reason})`);
        }
      } else verifyNotes.push(`unreachable callback refused with ${describe(unreachable.error)}`);

      // The real subscription, with Hookbench's receiver as the callback.
      const receiver = new WebhookReceiver({ port: opts.receiverPort, publicUrl: opts.callbackUrl });
      await receiver.start();
      const token = receiver.newToken();
      const secret = generateSecret();
      const cbUrl = receiver.callbackUrl(token);
      callbackLabel = cbUrl;
      receiver.addRoute({ token, label: t.name, secrets: [secret], eventName: t.name, payloadSchema: t.payloadSchema, profile });
      const deliveries: ReceivedDelivery[] = [];
      receiver.on("delivery", (d: ReceivedDelivery) => {
        if (d.token === token) deliveries.push(d);
      });
      let wellKnownFetched = false;
      receiver.on("well-known", () => {
        wellKnownFetched = true;
      });
      const ttlAsked = 600_000;
      const asked = Date.now();
      const sub = await attempt(() => subscribeTo(cbUrl, { secret, ttlMs: ttlAsked }));
      const deliverySkip = (why: string) => results.skipAll(RULES.filter((r) => r.group === "delivery").map((r) => r.id), why);
      if (!sub.ok) {
        const local = !opts.callbackUrl;
        const why = local
          ? `the server would not subscribe Hookbench's local callback ${cbUrl} (${describe(sub.error)}); conformant servers refuse loopback http callbacks, so pass --callback-url with a public https URL that forwards to ${receiver.baseUrl}`
          : `events/subscribe to ${cbUrl} failed: ${describe(sub.error)}`;
        if (local) {
          results.skipAll(["subscribe.result", "subscribe.ttl", "subscribe.idempotent", "unsubscribe.removes", "unsubscribe.not-found"], why);
        } else {
          results.violate("subscribe.result", why);
          results.skipAll(["subscribe.ttl", "subscribe.idempotent", "unsubscribe.removes", "unsubscribe.not-found"], "events/subscribe failed");
        }
        if (verifyFail) results.violate("subscribe.verification", verifyFail);
        else if (verifyNotes.length > 0) results.pass("subscribe.verification", `${verifyNotes.join("; ")}; the handshake itself could not be observed (${local ? "local callback refused" : "subscribe failed"})`);
        deliverySkip("no subscription to deliver to");
      } else {
        const s = sub.value;
        const problems: string[] = [];
        if (typeof s.id !== "string" || s.id.length === 0) problems.push("id is missing");
        if (!("refreshBefore" in s)) problems.push("refreshBefore is missing (it is always present, null for no expiry)");
        else if (s.refreshBefore !== null && (typeof s.refreshBefore !== "string" || Number.isNaN(Date.parse(s.refreshBefore)))) problems.push(`refreshBefore ${JSON.stringify(s.refreshBefore)} is not an ISO 8601 timestamp`);
        if ("cursor" in s && s.cursor !== null && typeof s.cursor !== "string") problems.push("cursor must be a string or null");
        if ("truncated" in s && typeof s.truncated !== "boolean") problems.push("truncated must be a boolean");
        if (profile.resultType && discovery.era === "modern" && s.resultType !== "complete") problems.push(`resultType is ${JSON.stringify(s.resultType)}`);
        if (problems.length > 0) results.violate("subscribe.result", problems.join("; "));
        else results.pass("subscribe.result", `id ${s.id}, refreshBefore ${s.refreshBefore}, cursor ${JSON.stringify(s.cursor ?? null)}`);
        receiver.updateRoute(token, { subscriptionId: s.id });

        if (s.refreshBefore === null) results.violate("subscribe.ttl", `asked for ttlMs ${ttlAsked} and was granted no expiry; a server MUST NOT return null unless the client asked with ttlMs: null`);
        else if (typeof s.refreshBefore === "string" && !Number.isNaN(Date.parse(s.refreshBefore))) {
          const grantedMs = Date.parse(s.refreshBefore) - asked;
          if (grantedMs > ttlAsked + 5000) results.warn("subscribe.ttl", `asked for ${ttlAsked} ms and was granted ${grantedMs} ms; the grant SHOULD be at most the suggestion (clamping up is only for impractically short suggestions)`);
          else results.pass("subscribe.ttl", `asked for ${ttlAsked} ms, granted ${Math.max(0, Math.round(grantedMs / 1000))} s`);
        } else results.skip("subscribe.ttl", "refreshBefore is missing or unreadable");

        // Verification, part 2: did the handshake reach our receiver before the subscribe result?
        const verification = deliveries.find((d) => d.kind === "verification");
        if (verifyFail) results.violate("subscribe.verification", verifyFail);
        else if (verification) {
          if (!verification.verify?.ok) results.violate("subscribe.verification", `the verification POST failed signature checks: ${verification.problems[0] ?? verification.verify?.message}`);
          else if (verification.subscriptionIdHeader === undefined) results.violate("subscribe.verification", "the verification POST has no X-MCP-Subscription-Id header");
          else results.pass("subscribe.verification", [...verifyNotes, "signed verification challenge received and echoed before the subscription became active"].join("; "));
        } else if (wellKnownFetched) results.pass("subscribe.verification", [...verifyNotes, "verified through /.well-known/mcp-webhook-receiver.json"].join("; "));
        else results.warn("subscribe.verification", [...verifyNotes, "no verification handshake reached the callback; fine only if this server verifies callbacks another way (allowlist or out-of-band)"].join("; "));

        const again = await attempt(() => subscribeTo(cbUrl, { secret, ttlMs: ttlAsked }));
        if (!again.ok) results.violate("subscribe.idempotent", `subscribing again with the same key failed: ${describe(again.error)}`);
        else if (again.value.id !== s.id) results.violate("subscribe.idempotent", `the same (principal, url, name, arguments) got a new id ${again.value.id} (first ${s.id}); subscribe is an idempotent upsert`);
        else results.pass("subscribe.idempotent", `same id ${s.id}${again.value.deliveryStatus ? `, deliveryStatus ${JSON.stringify(again.value.deliveryStatus)}` : ""}`);

        // Deliveries.
        const fired = await fire(t);
        const waitUntil = Date.now() + deliveryWait;
        while (Date.now() < waitUntil && !deliveries.some((d) => d.kind === "event")) await sleep(50);
        const delivery = deliveries.find((d) => d.kind === "event");
        if (!delivery) deliverySkip(fired ? `the trigger fired but no delivery reached ${cbUrl} within ${deliveryWait} ms` : noTrigger);
        else {
          const h = delivery.headers;
          const missing = ["webhook-id", "webhook-timestamp", "webhook-signature", "x-mcp-subscription-id"].filter((n) => h[n] === undefined);
          const headerProblems: string[] = [];
          if (missing.length > 0) headerProblems.push(`missing ${missing.join(", ")}`);
          if (!(h["content-type"] ?? "").startsWith("application/json")) headerProblems.push(`Content-Type is ${JSON.stringify(h["content-type"] ?? null)}`);
          if (h["x-mcp-subscription-id"] !== undefined && h["x-mcp-subscription-id"] !== s.id) headerProblems.push(`X-MCP-Subscription-Id is ${h["x-mcp-subscription-id"]}, but events/subscribe returned ${s.id}`);
          if (headerProblems.length > 0) results.violate("delivery.headers", headerProblems.join("; "));
          else results.pass("delivery.headers", `webhook-id, webhook-timestamp, webhook-signature, X-MCP-Subscription-Id ${s.id}`);

          const v = delivery.verify;
          if (!v) results.skip("delivery.signature", "the delivery was not verified");
          else if (v.ok || v.failure === "stale-timestamp" || v.failure === "future-timestamp") results.pass("delivery.signature", `v1 HMAC-SHA256 verified with the subscription secret${v.v1Count > 1 ? ` (${v.v1Count} signatures)` : ""}`);
          else if (v.failure === "missing-headers") results.violate("delivery.signature", v.message);
          else if (v.failure === "bad-timestamp") results.skip("delivery.signature", "the timestamp is unusable, see delivery.timestamp");
          else results.violate("delivery.signature", `${v.message}${v.diagnosis ? `: ${v.diagnosis}` : ""}`);

          const body = isObject(delivery.json) ? delivery.json : {};
          const eventId = typeof body["eventId"] === "string" ? body["eventId"] : undefined;
          const wid = delivery.webhookId;
          if (wid === undefined) results.violate("delivery.webhook-id", "no webhook-id header");
          else if (profile.webhookId === "independent") {
            observedWebhookId = wid === eventId ? "event-id" : "independent";
            if (wid === eventId) results.violate("delivery.webhook-id", `webhook-id equals the eventId (${wid}); SEP-3415 says it identifies the message and MUST NOT be derived from eventId (ChatGPT-dialect clients expect this, see interop.consumers)`);
            else if (!/^[A-Za-z0-9_-]+$/.test(wid)) results.violate("delivery.webhook-id", `webhook-id "${wid}" has characters outside A-Z a-z 0-9 _ -`);
            else results.pass("delivery.webhook-id", `webhook-id ${wid} is independent of eventId ${eventId ?? "(none)"}`);
          } else {
            observedWebhookId = wid === eventId ? "event-id" : "independent";
            if (wid !== eventId) results.violate("delivery.webhook-id", `webhook-id ${wid} differs from eventId ${eventId ?? "(none)"}; ChatGPT's guide requires them to match`);
            else results.pass("delivery.webhook-id", `webhook-id equals eventId ${wid}, as ChatGPT expects`);
          }

          if (v?.failure === "bad-timestamp") results.set("delivery.timestamp", "fail", v.message);
          else if (v?.failure === "stale-timestamp" || v?.failure === "future-timestamp") results.violate("delivery.timestamp", v.message);
          else results.pass("delivery.timestamp", `signed ${v?.ageSeconds ?? 0} s before it arrived`);

          const occ = occurrenceProblems(delivery.json, t.name, t.payloadSchema);
          if (occ.length > 0) results.violate("delivery.occurrence", occ.slice(0, 3).join("; "));
          else results.pass("delivery.occurrence", `eventId ${eventId}, data matches payloadSchema, cursor ${JSON.stringify(body["cursor"] ?? null)}`);

          if (delivery.bodyBytes > MAX_DELIVERY_BYTES) {
            if (profile.hardBodyLimit) results.set("delivery.size", "fail", `${delivery.bodyBytes} bytes; ChatGPT rejects bodies over 262144 bytes (256 KiB)`);
            else results.violate("delivery.size", `${delivery.bodyBytes} bytes; servers SHOULD keep deliveries at or under 262144 bytes (256 KiB)`);
          } else results.pass("delivery.size", `${delivery.bodyBytes} bytes`);
        }

        // Unsubscribe, and make sure deliveries stop.
        const un = await attempt(() => client.call<JsonObject>(METHODS.unsubscribe, { name: t.name, arguments: {}, delivery: { mode: "webhook", url: cbUrl } }));
        if (!un.ok) {
          results.violate("unsubscribe.removes", `events/unsubscribe failed: ${describe(un.error)}`);
          results.skip("unsubscribe.not-found", "events/unsubscribe failed");
        } else {
          const r = un.value;
          const shapeProblem = profile.resultType && discovery.era === "modern" && r.resultType !== "complete" ? `; resultType is ${JSON.stringify(r.resultType)}` : "";
          let stopped = "";
          if (trigger) {
            const before = deliveries.filter((d) => d.kind === "event").length;
            await fire(t);
            await sleep(Math.min(1500, deliveryWait));
            const after = deliveries.filter((d) => d.kind === "event").length;
            if (after > before) {
              results.violate("unsubscribe.removes", `events/unsubscribe answered success, but ${after - before} delivery(ies) still arrived afterwards`);
            } else stopped = "; no delivery arrived after it";
          }
          if (!results.has("unsubscribe.removes")) {
            if (shapeProblem) results.violate("unsubscribe.removes", `the result is not an empty Result${shapeProblem}`);
            else results.pass("unsubscribe.removes", `empty result${stopped}`);
          }
          if (profile.name === "chatgpt") results.skip("unsubscribe.not-found", "OpenAI's guide does not define the error for an unknown subscription");
          else {
            const again2 = await attempt(() => client.call<JsonObject>(METHODS.unsubscribe, { name: t.name, arguments: {}, delivery: { mode: "webhook", url: cbUrl } }));
            if (again2.ok) results.violate("unsubscribe.not-found", "unsubscribing the same key a second time succeeded; an unknown key gets NotFound");
            else {
              const e = expectError(again2.error, "NotFound", profile);
              if (e.ok) results.pass("unsubscribe.not-found", e.detail);
              else results.violate("unsubscribe.not-found", e.detail);
            }
          }
        }
      }
      await receiver.close();
    }
  }

  // ---------- interop ----------
  const notes: string[] = [];
  if (key === "extensions") notes.push("capability only under extensions: ChatGPT and the Vercel AI SDK look for the top-level capabilities.events key and will not see this server's events (advertising both keys is harmless)");
  else if (key === "top-level") notes.push("capability only under the top-level events key: SEP-3415 clients (TanStack AI, Mastra) look under capabilities.extensions");
  else notes.push("both capability keys are advertised: SEP-3415 clients and ChatGPT / Vercel AI SDK can all see the events");
  if (observedWebhookId === "independent") notes.push("webhook-id is independent of eventId, as SEP-3415 says; ChatGPT, the Vercel AI SDK and TanStack AI (as of 2026-11) reject such deliveries");
  if (observedWebhookId === "event-id") notes.push("webhook-id equals eventId, which ChatGPT, the Vercel AI SDK and TanStack AI expect; SEP-3415 says it MUST NOT be derived from eventId");
  if (webhookTarget === undefined && profile.name === "sep-3415") notes.push("no webhook delivery: ChatGPT only uses webhooks, so ChatGPT cannot subscribe");
  results.info("interop.consumers", notes.join("; "));

  return report();
}
