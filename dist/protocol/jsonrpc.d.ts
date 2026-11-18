import type { JsonObject } from "./types.js";
export type JsonRpcId = string | number;
export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: JsonObject;
}
export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: JsonObject;
}
export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}
export interface JsonRpcSuccess {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result: JsonObject;
}
export interface JsonRpcFailure {
    jsonrpc: "2.0";
    id?: JsonRpcId | null;
    error: JsonRpcErrorObject;
}
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export declare function isObject(v: unknown): v is JsonObject;
export declare function isResponse(m: unknown): m is JsonRpcResponse;
export declare function isFailure(m: unknown): m is JsonRpcFailure;
export declare function isNotification(m: unknown): m is JsonRpcNotification;
export declare function isRequest(m: unknown): m is JsonRpcRequest;
/** A JSON-RPC error raised as an exception, with the HTTP status it arrived with. */
export declare class RpcError extends Error {
    name: string;
    readonly code: number;
    readonly data: unknown;
    readonly httpStatus: number | undefined;
    constructor(err: JsonRpcErrorObject, httpStatus?: number);
}
export declare function errorName(code: number): string;
export declare function rpcError(id: JsonRpcId | null | undefined, code: number, message: string, data?: unknown): JsonRpcFailure;
export declare function rpcResult(id: JsonRpcId, result: JsonObject): JsonRpcSuccess;
