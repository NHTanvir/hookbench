/**
 * An MCP Events client over Streamable HTTP. It speaks protocol 2026-07-28 (stateless,
 * per-request _meta, server/discover) and falls back to the initialize handshake for
 * servers that only speak an older revision, such as ChatGPT-dialect servers.
 */
import {
  EVENTS_EXTENSION,
  ERROR,
  HEADERS,
  KNOWN_LEGACY_VERSIONS,
  LEGACY_PROTOCOL_VERSION,
  META,
  METHODS,
  NAMED_METHODS,
  PROTOCOL_VERSION,
} from "../protocol/constants.js";
import { encodeHeaderValue, paramHeaders } from "../protocol/headers.js";
import { isFailure, isObject, RpcError, type JsonRpcRequest } from "../protocol/jsonrpc.js";
import type {
  EventDescriptor,
  JsonObject,
  ListEventsResult,
  PollParams,
  PollResult,
  ServerIdentity,
  StreamParams,
  SubscribeParams,
  SubscribeResult,
  UnsubscribeParams,
} from "../protocol/types.js";
import { TOOL_NAME, VERSION } from "../version.js";
import { openRpcStream, postRpc, TransportError, type HttpRpcResult, type RpcStream } from "./transport.js";

export type CapabilityKey = "extensions" | "top-level" | "both" | "none";

export interface Discovery {
  era: "modern" | "legacy";
  protocolVersion: string;
  supportedVersions: string[];
  capabilities: JsonObject;
  serverInfo?: ServerIdentity;
  capabilityKey: CapabilityKey;
  /** The settings object for Events, from whichever key the server used. */
  eventsSettings?: JsonObject;
  /** `resultType` exactly as the server sent it (undefined when absent). */
  resultType?: unknown;
  /** Why the client fell back to initialize, when it did. */
  fallbackReason?: string;
  raw: JsonObject;
}

export interface ClientOptions {
  url: string;
  /** Sent on every request, e.g. Authorization. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Skip detection and use this era. */
  era?: "modern" | "legacy";
}

export interface RequestOptions {
  /** Extra headers for this request. */
  headers?: Record<string, string>;
  /** Replace or (with null) remove computed headers; checks use this to send wrong headers on purpose. */
  overrideHeaders?: Record<string, string | null>;
  /** Leave out the configured headers (for example Authorization) for this request. */
  withoutConfiguredHeaders?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SentRequest extends HttpRpcResult {
  request: JsonRpcRequest;
  requestHeaders: Record<string, string>;
}

export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText?: string,
  ) {
    super(message);
  }
}

export function capabilityKeyOf(capabilities: unknown): { key: CapabilityKey; settings?: JsonObject } {
  if (!isObject(capabilities)) return { key: "none" };
  const ext = isObject(capabilities["extensions"]) ? (capabilities["extensions"] as JsonObject)[EVENTS_EXTENSION] : undefined;
  const top = capabilities["events"];
  const hasExt = isObject(ext);
  const hasTop = isObject(top);
  if (hasExt && hasTop) return { key: "both", settings: ext as JsonObject };
  if (hasExt) return { key: "extensions", settings: ext as JsonObject };
  if (hasTop) return { key: "top-level", settings: top as JsonObject };
  return { key: "none" };
}

export class McpEventsClient {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private nextId = 1;
  private sessionId: string | undefined;
  private era: "modern" | "legacy";
  private eraForced: boolean;
  private protocolVersion = PROTOCOL_VERSION;
  private readonly schemas = new Map<string, unknown>();
  discovery: Discovery | undefined;

  constructor(opts: ClientOptions) {
    this.url = opts.url;
    this.headers = { ...(opts.headers ?? {}) };
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.era = opts.era ?? "modern";
    this.eraForced = opts.era !== undefined;
  }

  get currentEra(): "modern" | "legacy" {
    return this.era;
  }

  /** Remember inputSchemas so x-mcp-header arguments are mirrored into Mcp-Param-* headers. */
  rememberSchemas(events: EventDescriptor[]): void {
    for (const e of events) this.schemas.set(e.name, e.inputSchema);
  }

  buildRequest(method: string, params: JsonObject = {}): JsonRpcRequest {
    const id = this.nextId++;
    const p: JsonObject = { ...params };
    if (this.era === "modern") {
      const meta = isObject(p["_meta"]) ? { ...(p["_meta"] as JsonObject) } : {};
      meta[META.protocolVersion] = this.protocolVersion;
      meta[META.clientInfo] = { name: TOOL_NAME, version: VERSION };
      meta[META.clientCapabilities] = { extensions: { [EVENTS_EXTENSION]: {} } };
      p["_meta"] = meta;
    }
    return { jsonrpc: "2.0", id, method, params: p };
  }

  buildHeaders(req: JsonRpcRequest, opts: RequestOptions = {}): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
    };
    if (this.era === "modern") {
      h[HEADERS.method] = req.method;
      const name = req.params?.["name"];
      if (NAMED_METHODS.has(req.method) && typeof name === "string") {
        h[HEADERS.name] = encodeHeaderValue(name);
        const args = isObject(req.params?.["arguments"]) ? (req.params?.["arguments"] as JsonObject) : undefined;
        for (const [k, v] of Object.entries(paramHeaders(this.schemas.get(name), args))) h[k.toLowerCase()] = v;
      }
    }
    if (this.sessionId) h[HEADERS.sessionId] = this.sessionId;
    if (!opts.withoutConfiguredHeaders) {
      for (const [k, v] of Object.entries(this.headers)) h[k.toLowerCase()] = v;
    }
    for (const [k, v] of Object.entries(opts.headers ?? {})) h[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(opts.overrideHeaders ?? {})) {
      if (v === null) delete h[k.toLowerCase()];
      else h[k.toLowerCase()] = v;
    }
    return h;
  }

  /** Send a request and return everything that came back, errors included. */
  async send(method: string, params: JsonObject = {}, opts: RequestOptions = {}): Promise<SentRequest> {
    const request = this.buildRequest(method, params);
    const requestHeaders = this.buildHeaders(request, opts);
    const result = await postRpc(this.url, request, requestHeaders, {
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      signal: opts.signal,
    });
    return { ...result, request, requestHeaders };
  }

  /** Send a request and return its result, throwing RpcError / HttpError otherwise. */
  async call<T = JsonObject>(method: string, params: JsonObject = {}, opts: RequestOptions = {}): Promise<T> {
    const sent = await this.send(method, params, opts);
    return unwrap<T>(sent);
  }

  async discover(): Promise<Discovery> {
    if (this.eraForced && this.era === "legacy") return this.initialize("legacy era requested");

    let sent: SentRequest;
    try {
      sent = await this.send(METHODS.discover);
    } catch (err) {
      throw err instanceof TransportError ? err : new TransportError(String(err));
    }

    const r = sent.response;
    if (r && !isFailure(r)) {
      const result = r.result;
      const caps = isObject(result["capabilities"]) ? (result["capabilities"] as JsonObject) : {};
      const { key, settings } = capabilityKeyOf(caps);
      const meta = isObject(result["_meta"]) ? (result["_meta"] as JsonObject) : {};
      const info = isObject(meta[META.serverInfo]) ? (meta[META.serverInfo] as ServerIdentity) : undefined;
      const versions = Array.isArray(result["supportedVersions"])
        ? (result["supportedVersions"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      this.discovery = {
        era: "modern",
        protocolVersion: this.protocolVersion,
        supportedVersions: versions,
        capabilities: caps,
        serverInfo: info,
        capabilityKey: key,
        eventsSettings: settings,
        resultType: result["resultType"],
        raw: result,
      };
      return this.discovery;
    }

    if (!this.eraForced) {
      if (r && isFailure(r)) {
        const code = r.error.code;
        if (code === ERROR.MethodNotFound) return this.initialize("server/discover is not implemented (-32601)");
        if (code === ERROR.UnsupportedProtocolVersion) {
          const data = isObject(r.error.data) ? r.error.data : {};
          const supported = Array.isArray(data["supported"]) ? (data["supported"] as unknown[]).filter((v): v is string => typeof v === "string") : [];
          const legacy = supported.find((v) => KNOWN_LEGACY_VERSIONS.includes(v));
          if (legacy) return this.initialize(`server supports ${supported.join(", ")}, not ${PROTOCOL_VERSION}`, legacy);
        }
      }
      if (!r && (sent.status === 400 || sent.status === 404 || sent.status === 405)) {
        return this.initialize(`server/discover got HTTP ${sent.status} without a modern JSON-RPC error`);
      }
    }
    return unwrap(sent) as never;
  }

  private async initialize(reason: string, version = LEGACY_PROTOCOL_VERSION): Promise<Discovery> {
    this.era = "legacy";
    this.protocolVersion = version;
    const sent = await this.send(METHODS.initialize, {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: TOOL_NAME, version: VERSION },
    });
    const result = unwrap<JsonObject>(sent);
    const session = sent.headers.get(HEADERS.sessionId);
    if (session) this.sessionId = session;
    if (typeof result["protocolVersion"] === "string") this.protocolVersion = result["protocolVersion"];
    // notifications/initialized: fire and forget; a 202 is expected.
    try {
      const note = { jsonrpc: "2.0" as const, method: METHODS.initialized };
      const h = this.buildHeaders({ jsonrpc: "2.0", id: 0, method: METHODS.initialized });
      await postRpc(this.url, note, h, { timeoutMs: this.timeoutMs });
    } catch {
      // Some servers do not care; the session works either way.
    }
    const caps = isObject(result["capabilities"]) ? (result["capabilities"] as JsonObject) : {};
    const { key, settings } = capabilityKeyOf(caps);
    this.discovery = {
      era: "legacy",
      protocolVersion: this.protocolVersion,
      supportedVersions: [this.protocolVersion],
      capabilities: caps,
      serverInfo: isObject(result["serverInfo"]) ? (result["serverInfo"] as ServerIdentity) : undefined,
      capabilityKey: key,
      eventsSettings: settings,
      resultType: result["resultType"],
      fallbackReason: reason,
      raw: result,
    };
    return this.discovery;
  }

  /** events/list, following nextCursor (at most 50 pages). */
  async listEvents(opts: RequestOptions = {}): Promise<{ events: EventDescriptor[]; pages: ListEventsResult[] }> {
    const pages: ListEventsResult[] = [];
    const events: EventDescriptor[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const params: JsonObject = cursor === undefined ? {} : { cursor };
      const page = await this.call<ListEventsResult>(METHODS.list, params, opts);
      pages.push(page);
      if (Array.isArray(page.events)) events.push(...page.events);
      const next = page.nextCursor;
      if (typeof next !== "string" || next.length === 0 || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    this.rememberSchemas(events.filter((e) => isObject(e) && typeof e.name === "string"));
    return { events, pages };
  }

  poll(params: PollParams, opts: RequestOptions = {}): Promise<PollResult> {
    return this.call<PollResult>(METHODS.poll, params as unknown as JsonObject, opts);
  }

  subscribe(params: SubscribeParams, opts: RequestOptions = {}): Promise<SubscribeResult> {
    return this.call<SubscribeResult>(METHODS.subscribe, params as unknown as JsonObject, opts);
  }

  unsubscribe(params: UnsubscribeParams, opts: RequestOptions = {}): Promise<JsonObject> {
    return this.call<JsonObject>(METHODS.unsubscribe, params as unknown as JsonObject, opts);
  }

  /** Open an events/stream request. The caller reads `stream.messages` and calls `stream.close()`. */
  async openStream(
    params: StreamParams,
    opts: RequestOptions & { connectTimeoutMs?: number } = {},
  ): Promise<{ requestId: number | string; request: JsonRpcRequest; stream: RpcStream }> {
    const request = this.buildRequest(METHODS.stream, params as unknown as JsonObject);
    const headers = this.buildHeaders(request, opts);
    const stream = await openRpcStream(this.url, request, headers, {
      connectTimeoutMs: opts.connectTimeoutMs ?? this.timeoutMs,
      signal: opts.signal,
    });
    return { requestId: request.id, request, stream };
  }
}

/** Turn an HTTP exchange into a result, or a precise error. */
export function unwrap<T>(sent: HttpRpcResult): T {
  const r = sent.response;
  if (r) {
    if (isFailure(r)) throw new RpcError(r.error, sent.status);
    return r.result as T;
  }
  const snippet = sent.bodyText ? `: ${sent.bodyText.replace(/\s+/g, " ").slice(0, 160)}` : "";
  if (sent.status === 404) throw new HttpError(`HTTP 404, no MCP endpoint here${snippet}`, sent.status, sent.bodyText);
  if (sent.status === 401 || sent.status === 403) {
    throw new HttpError(`HTTP ${sent.status}: the server wants credentials (pass --header "Authorization: Bearer …")${snippet}`, sent.status, sent.bodyText);
  }
  throw new HttpError(`HTTP ${sent.status} without a JSON-RPC response${snippet}`, sent.status, sent.bodyText);
}
