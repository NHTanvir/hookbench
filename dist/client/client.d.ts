import { type JsonRpcRequest } from "../protocol/jsonrpc.js";
import type { EventDescriptor, JsonObject, ListEventsResult, PollParams, PollResult, ServerIdentity, StreamParams, SubscribeParams, SubscribeResult, UnsubscribeParams } from "../protocol/types.js";
import { type HttpRpcResult, type RpcStream } from "./transport.js";
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
export declare class HttpError extends Error {
    readonly status: number;
    readonly bodyText?: string | undefined;
    name: string;
    constructor(message: string, status: number, bodyText?: string | undefined);
}
export declare function capabilityKeyOf(capabilities: unknown): {
    key: CapabilityKey;
    settings?: JsonObject;
};
export declare class McpEventsClient {
    readonly url: string;
    private readonly headers;
    private readonly timeoutMs;
    private nextId;
    private sessionId;
    private era;
    private eraForced;
    private protocolVersion;
    private readonly schemas;
    discovery: Discovery | undefined;
    constructor(opts: ClientOptions);
    get currentEra(): "modern" | "legacy";
    /** Remember inputSchemas so x-mcp-header arguments are mirrored into Mcp-Param-* headers. */
    rememberSchemas(events: EventDescriptor[]): void;
    buildRequest(method: string, params?: JsonObject): JsonRpcRequest;
    buildHeaders(req: JsonRpcRequest, opts?: RequestOptions): Record<string, string>;
    /** Send a request and return everything that came back, errors included. */
    send(method: string, params?: JsonObject, opts?: RequestOptions): Promise<SentRequest>;
    /** Send a request and return its result, throwing RpcError / HttpError otherwise. */
    call<T = JsonObject>(method: string, params?: JsonObject, opts?: RequestOptions): Promise<T>;
    discover(): Promise<Discovery>;
    private initialize;
    /** events/list, following nextCursor (at most 50 pages). */
    listEvents(opts?: RequestOptions): Promise<{
        events: EventDescriptor[];
        pages: ListEventsResult[];
    }>;
    poll(params: PollParams, opts?: RequestOptions): Promise<PollResult>;
    subscribe(params: SubscribeParams, opts?: RequestOptions): Promise<SubscribeResult>;
    unsubscribe(params: UnsubscribeParams, opts?: RequestOptions): Promise<JsonObject>;
    /** Open an events/stream request. The caller reads `stream.messages` and calls `stream.close()`. */
    openStream(params: StreamParams, opts?: RequestOptions & {
        connectTimeoutMs?: number;
    }): Promise<{
        requestId: number | string;
        request: JsonRpcRequest;
        stream: RpcStream;
    }>;
}
/** Turn an HTTP exchange into a result, or a precise error. */
export declare function unwrap<T>(sent: HttpRpcResult): T;
