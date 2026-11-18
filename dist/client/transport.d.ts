/**
 * Streamable HTTP (2026-07-28): every JSON-RPC message is its own POST, answered with one
 * JSON object or with an SSE stream scoped to that request. Closing the stream cancels it.
 */
import { type JsonRpcMessage, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse } from "../protocol/jsonrpc.js";
export interface SseEvent {
    event?: string;
    data: string;
    id?: string;
}
/** Parse a text/event-stream body. Comment lines (":") are skipped, as the SSE spec says. */
export declare function readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>;
export interface HttpRpcResult {
    status: number;
    headers: Headers;
    contentType: string;
    /** The JSON-RPC response to the request, when one arrived. */
    response?: JsonRpcResponse;
    /** Notifications that arrived on an SSE response before the result. */
    notifications: JsonRpcNotification[];
    /** Body text when it was not a JSON-RPC message (kept for diagnostics, truncated). */
    bodyText?: string;
}
export interface PostOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}
export declare class TransportError extends Error {
    name: string;
}
/** POST one JSON-RPC message and wait for its response (JSON body or SSE stream). */
export declare function postRpc(url: string, message: JsonRpcRequest | JsonRpcNotification, headers: Record<string, string>, opts?: PostOptions): Promise<HttpRpcResult>;
export interface RpcStream {
    status: number;
    headers: Headers;
    contentType: string;
    /** Set when the server answered with a single JSON response instead of a stream. */
    response?: JsonRpcResponse;
    bodyText?: string;
    /** Every JSON-RPC message on the stream, in order. Ends when the stream closes. */
    messages: AsyncGenerator<JsonRpcMessage>;
    /** Abort the request stream: on Streamable HTTP this is how a client cancels. */
    close(): void;
}
/** POST a long-lived request (events/stream) and expose the SSE response as messages. */
export declare function openRpcStream(url: string, message: JsonRpcRequest, headers: Record<string, string>, opts?: {
    connectTimeoutMs?: number;
    signal?: AbortSignal;
}): Promise<RpcStream>;
export declare function describeFetchError(err: unknown): string;
