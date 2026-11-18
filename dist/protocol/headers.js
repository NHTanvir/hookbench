/**
 * Streamable HTTP request headers for 2026-07-28: Mcp-Name and Mcp-Param-{Name},
 * with the Base64 sentinel (`=?base64?…?=`) for values that are not plain ASCII.
 */
import { isObject } from "./jsonrpc.js";
const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
/** Visible ASCII, inner spaces allowed, no leading or trailing whitespace. */
function isPlainHeaderValue(value) {
    if (value.length === 0)
        return false;
    if (!/^[\x20-\x7E]+$/.test(value))
        return false;
    if (value !== value.trim())
        return false;
    return !(value.startsWith("=?base64?") && value.endsWith("?="));
}
export function encodeHeaderValue(value) {
    if (isPlainHeaderValue(value))
        return value;
    return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
export function decodeHeaderValue(value) {
    const m = SENTINEL.exec(value);
    return m ? Buffer.from(m[1] ?? "", "base64").toString("utf8") : value;
}
/** Convert an argument value to its header form, or undefined when it has none. */
function headerForm(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return undefined;
}
/**
 * Headers for properties annotated with `x-mcp-header` in an event type's inputSchema.
 * Clients on Streamable HTTP MUST send one for each annotated property that has a value.
 */
export function paramHeaders(inputSchema, args) {
    const out = {};
    if (!isObject(inputSchema) || !isObject(inputSchema["properties"]) || !args)
        return out;
    for (const [prop, schema] of Object.entries(inputSchema["properties"])) {
        if (!isObject(schema))
            continue;
        const headerName = schema["x-mcp-header"];
        if (typeof headerName !== "string" || headerName.length === 0)
            continue;
        const form = headerForm(args[prop]);
        if (form === undefined)
            continue;
        out[`Mcp-Param-${headerName}`] = encodeHeaderValue(form);
    }
    return out;
}
/** The annotated properties of an inputSchema: header name -> property name. */
export function annotatedProperties(inputSchema) {
    const out = new Map();
    if (!isObject(inputSchema) || !isObject(inputSchema["properties"]))
        return out;
    for (const [prop, schema] of Object.entries(inputSchema["properties"])) {
        if (isObject(schema) && typeof schema["x-mcp-header"] === "string") {
            out.set(schema["x-mcp-header"].toLowerCase(), prop);
        }
    }
    return out;
}
export { headerForm };
