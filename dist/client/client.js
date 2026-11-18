/**
 * An MCP Events client over Streamable HTTP. It speaks protocol 2026-07-28 (stateless,
 * per-request _meta, server/discover) and falls back to the initialize handshake for
 * servers that only speak an older revision, such as ChatGPT-dialect servers.
 */
import { EVENTS_EXTENSION, ERROR, HEADERS, KNOWN_LEGACY_VERSIONS, LEGACY_PROTOCOL_VERSION, META, METHODS, NAMED_METHODS, PROTOCOL_VERSION, } from "../protocol/constants.js";
import { encodeHeaderValue, paramHeaders } from "../protocol/headers.js";
import { isFailure, isObject, RpcError } from "../protocol/jsonrpc.js";
import { TOOL_NAME, VERSION } from "../version.js";
import { openRpcStream, postRpc, TransportError } from "./transport.js";
export class HttpError extends Error {
    status;
    bodyText;
    name = "HttpError";
    constructor(message, status, bodyText) {
        super(message);
        this.status = status;
        this.bodyText = bodyText;
    }
}
export function capabilityKeyOf(capabilities) {
    if (!isObject(capabilities))
        return { key: "none" };
    const ext = isObject(capabilities["extensions"]) ? capabilities["extensions"][EVENTS_EXTENSION] : undefined;
    const top = capabilities["events"];
    const hasExt = isObject(ext);
    const hasTop = isObject(top);
    if (hasExt && hasTop)
        return { key: "both", settings: ext };
    if (hasExt)
        return { key: "extensions", settings: ext };
    if (hasTop)
        return { key: "top-level", settings: top };
    return { key: "none" };
}
export class McpEventsClient {
    url;
    headers;
    timeoutMs;
    nextId = 1;
    sessionId;
    era;
    eraForced;
    protocolVersion = PROTOCOL_VERSION;
    schemas = new Map();
    discovery;
    constructor(opts) {
        this.url = opts.url;
        this.headers = { ...(opts.headers ?? {}) };
        this.timeoutMs = opts.timeoutMs ?? 10_000;
        this.era = opts.era ?? "modern";
        this.eraForced = opts.era !== undefined;
    }
    get currentEra() {
        return this.era;
    }
    /** Remember inputSchemas so x-mcp-header arguments are mirrored into Mcp-Param-* headers. */
    rememberSchemas(events) {
        for (const e of events)
            this.schemas.set(e.name, e.inputSchema);
    }
    buildRequest(method, params = {}) {
        const id = this.nextId++;
        const p = { ...params };
        if (this.era === "modern") {
            const meta = isObject(p["_meta"]) ? { ...p["_meta"] } : {};
            meta[META.protocolVersion] = this.protocolVersion;
            meta[META.clientInfo] = { name: TOOL_NAME, version: VERSION };
            meta[META.clientCapabilities] = { extensions: { [EVENTS_EXTENSION]: {} } };
            p["_meta"] = meta;
        }
        return { jsonrpc: "2.0", id, method, params: p };
    }
    buildHeaders(req, opts = {}) {
        const h = {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": this.protocolVersion,
        };
        if (this.era === "modern") {
            h[HEADERS.method] = req.method;
            const name = req.params?.["name"];
            if (NAMED_METHODS.has(req.method) && typeof name === "string") {
                h[HEADERS.name] = encodeHeaderValue(name);
                const args = isObject(req.params?.["arguments"]) ? req.params?.["arguments"] : undefined;
                for (const [k, v] of Object.entries(paramHeaders(this.schemas.get(name), args)))
                    h[k.toLowerCase()] = v;
            }
        }
        if (this.sessionId)
            h[HEADERS.sessionId] = this.sessionId;
        if (!opts.withoutConfiguredHeaders) {
            for (const [k, v] of Object.entries(this.headers))
                h[k.toLowerCase()] = v;
        }
        for (const [k, v] of Object.entries(opts.headers ?? {}))
            h[k.toLowerCase()] = v;
        for (const [k, v] of Object.entries(opts.overrideHeaders ?? {})) {
            if (v === null)
                delete h[k.toLowerCase()];
            else
                h[k.toLowerCase()] = v;
        }
        return h;
    }
    /** Send a request and return everything that came back, errors included. */
    async send(method, params = {}, opts = {}) {
        const request = this.buildRequest(method, params);
        const requestHeaders = this.buildHeaders(request, opts);
        const result = await postRpc(this.url, request, requestHeaders, {
            timeoutMs: opts.timeoutMs ?? this.timeoutMs,
            signal: opts.signal,
        });
        return { ...result, request, requestHeaders };
    }
    /** Send a request and return its result, throwing RpcError / HttpError otherwise. */
    async call(method, params = {}, opts = {}) {
        const sent = await this.send(method, params, opts);
        return unwrap(sent);
    }
    async discover() {
        if (this.eraForced && this.era === "legacy")
            return this.initialize("legacy era requested");
        let sent;
        try {
            sent = await this.send(METHODS.discover);
        }
        catch (err) {
            throw err instanceof TransportError ? err : new TransportError(String(err));
        }
        const r = sent.response;
        if (r && !isFailure(r)) {
            const result = r.result;
            const caps = isObject(result["capabilities"]) ? result["capabilities"] : {};
            const { key, settings } = capabilityKeyOf(caps);
            const meta = isObject(result["_meta"]) ? result["_meta"] : {};
            const info = isObject(meta[META.serverInfo]) ? meta[META.serverInfo] : undefined;
            const versions = Array.isArray(result["supportedVersions"])
                ? result["supportedVersions"].filter((v) => typeof v === "string")
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
                if (code === ERROR.MethodNotFound)
                    return this.initialize("server/discover is not implemented (-32601)");
                if (code === ERROR.UnsupportedProtocolVersion) {
                    const data = isObject(r.error.data) ? r.error.data : {};
                    const supported = Array.isArray(data["supported"]) ? data["supported"].filter((v) => typeof v === "string") : [];
                    const legacy = supported.find((v) => KNOWN_LEGACY_VERSIONS.includes(v));
                    if (legacy)
                        return this.initialize(`server supports ${supported.join(", ")}, not ${PROTOCOL_VERSION}`, legacy);
                }
            }
            if (!r && (sent.status === 400 || sent.status === 404 || sent.status === 405)) {
                return this.initialize(`server/discover got HTTP ${sent.status} without a modern JSON-RPC error`);
            }
        }
        return unwrap(sent);
    }
    async initialize(reason, version = LEGACY_PROTOCOL_VERSION) {
        this.era = "legacy";
        this.protocolVersion = version;
        const sent = await this.send(METHODS.initialize, {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: TOOL_NAME, version: VERSION },
        });
        const result = unwrap(sent);
        const session = sent.headers.get(HEADERS.sessionId);
        if (session)
            this.sessionId = session;
        if (typeof result["protocolVersion"] === "string")
            this.protocolVersion = result["protocolVersion"];
        // notifications/initialized: fire and forget; a 202 is expected.
        try {
            const note = { jsonrpc: "2.0", method: METHODS.initialized };
            const h = this.buildHeaders({ jsonrpc: "2.0", id: 0, method: METHODS.initialized });
            await postRpc(this.url, note, h, { timeoutMs: this.timeoutMs });
        }
        catch {
            // Some servers do not care; the session works either way.
        }
        const caps = isObject(result["capabilities"]) ? result["capabilities"] : {};
        const { key, settings } = capabilityKeyOf(caps);
        this.discovery = {
            era: "legacy",
            protocolVersion: this.protocolVersion,
            supportedVersions: [this.protocolVersion],
            capabilities: caps,
            serverInfo: isObject(result["serverInfo"]) ? result["serverInfo"] : undefined,
            capabilityKey: key,
            eventsSettings: settings,
            resultType: result["resultType"],
            fallbackReason: reason,
            raw: result,
        };
        return this.discovery;
    }
    /** events/list, following nextCursor (at most 50 pages). */
    async listEvents(opts = {}) {
        const pages = [];
        const events = [];
        const seen = new Set();
        let cursor;
        for (let i = 0; i < 50; i++) {
            const params = cursor === undefined ? {} : { cursor };
            const page = await this.call(METHODS.list, params, opts);
            pages.push(page);
            if (Array.isArray(page.events))
                events.push(...page.events);
            const next = page.nextCursor;
            if (typeof next !== "string" || next.length === 0 || seen.has(next))
                break;
            seen.add(next);
            cursor = next;
        }
        this.rememberSchemas(events.filter((e) => isObject(e) && typeof e.name === "string"));
        return { events, pages };
    }
    poll(params, opts = {}) {
        return this.call(METHODS.poll, params, opts);
    }
    subscribe(params, opts = {}) {
        return this.call(METHODS.subscribe, params, opts);
    }
    unsubscribe(params, opts = {}) {
        return this.call(METHODS.unsubscribe, params, opts);
    }
    /** Open an events/stream request. The caller reads `stream.messages` and calls `stream.close()`. */
    async openStream(params, opts = {}) {
        const request = this.buildRequest(METHODS.stream, params);
        const headers = this.buildHeaders(request, opts);
        const stream = await openRpcStream(this.url, request, headers, {
            connectTimeoutMs: opts.connectTimeoutMs ?? this.timeoutMs,
            signal: opts.signal,
        });
        return { requestId: request.id, request, stream };
    }
}
/** Turn an HTTP exchange into a result, or a precise error. */
export function unwrap(sent) {
    const r = sent.response;
    if (r) {
        if (isFailure(r))
            throw new RpcError(r.error, sent.status);
        return r.result;
    }
    const snippet = sent.bodyText ? `: ${sent.bodyText.replace(/\s+/g, " ").slice(0, 160)}` : "";
    if (sent.status === 404)
        throw new HttpError(`HTTP 404, no MCP endpoint here${snippet}`, sent.status, sent.bodyText);
    if (sent.status === 401 || sent.status === 403) {
        throw new HttpError(`HTTP ${sent.status}: the server wants credentials (pass --header "Authorization: Bearer …")${snippet}`, sent.status, sent.bodyText);
    }
    throw new HttpError(`HTTP ${sent.status} without a JSON-RPC response${snippet}`, sent.status, sent.bodyText);
}
