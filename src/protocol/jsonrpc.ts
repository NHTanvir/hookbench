import { ERROR, LEGACY_EVENT_ERROR } from "./constants.js";
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

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  return isObject(m) && ("result" in m || "error" in m) && !("method" in m);
}

export function isFailure(m: unknown): m is JsonRpcFailure {
  return isResponse(m) && "error" in m && isObject((m as JsonRpcFailure).error);
}

export function isNotification(m: unknown): m is JsonRpcNotification {
  return isObject(m) && typeof m["method"] === "string" && !("id" in m);
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  return (
    isObject(m) &&
    typeof m["method"] === "string" &&
    "id" in m &&
    (typeof m["id"] === "string" || typeof m["id"] === "number")
  );
}

/** A JSON-RPC error raised as an exception, with the HTTP status it arrived with. */
export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  readonly data: unknown;
  readonly httpStatus: number | undefined;

  constructor(err: JsonRpcErrorObject, httpStatus?: number) {
    super(`${errorName(err.code)} (${err.code}): ${err.message}`);
    this.code = err.code;
    this.data = err.data;
    this.httpStatus = httpStatus;
  }
}

const NAMES = new Map<number, string>([
  ...Object.entries(ERROR).map(([k, v]) => [v, k] as [number, string]),
  ...Object.entries(LEGACY_EVENT_ERROR).map(([k, v]) => [v, `${k} (pre-SEP numbering)`] as [number, string]),
]);

export function errorName(code: number): string {
  return NAMES.get(code) ?? "Error";
}

export function rpcError(id: JsonRpcId | null | undefined, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return id === undefined || id === null ? { jsonrpc: "2.0", error } : { jsonrpc: "2.0", id, error };
}

export function rpcResult(id: JsonRpcId, result: JsonObject): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}
