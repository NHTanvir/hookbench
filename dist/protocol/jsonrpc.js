import { ERROR, LEGACY_EVENT_ERROR } from "./constants.js";
export function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function isResponse(m) {
    return isObject(m) && ("result" in m || "error" in m) && !("method" in m);
}
export function isFailure(m) {
    return isResponse(m) && "error" in m && isObject(m.error);
}
export function isNotification(m) {
    return isObject(m) && typeof m["method"] === "string" && !("id" in m);
}
export function isRequest(m) {
    return (isObject(m) &&
        typeof m["method"] === "string" &&
        "id" in m &&
        (typeof m["id"] === "string" || typeof m["id"] === "number"));
}
/** A JSON-RPC error raised as an exception, with the HTTP status it arrived with. */
export class RpcError extends Error {
    name = "RpcError";
    code;
    data;
    httpStatus;
    constructor(err, httpStatus) {
        super(`${errorName(err.code)} (${err.code}): ${err.message}`);
        this.code = err.code;
        this.data = err.data;
        this.httpStatus = httpStatus;
    }
}
const NAMES = new Map([
    ...Object.entries(ERROR).map(([k, v]) => [v, k]),
    ...Object.entries(LEGACY_EVENT_ERROR).map(([k, v]) => [v, `${k} (pre-SEP numbering)`]),
]);
export function errorName(code) {
    return NAMES.get(code) ?? "Error";
}
export function rpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined)
        error.data = data;
    return id === undefined || id === null ? { jsonrpc: "2.0", error } : { jsonrpc: "2.0", id, error };
}
export function rpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}
