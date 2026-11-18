import type { JsonObject } from "./types.js";
export declare function encodeHeaderValue(value: string): string;
export declare function decodeHeaderValue(value: string): string;
/** Convert an argument value to its header form, or undefined when it has none. */
declare function headerForm(value: unknown): string | undefined;
/**
 * Headers for properties annotated with `x-mcp-header` in an event type's inputSchema.
 * Clients on Streamable HTTP MUST send one for each annotated property that has a value.
 */
export declare function paramHeaders(inputSchema: unknown, args: JsonObject | undefined): Record<string, string>;
/** The annotated properties of an inputSchema: header name -> property name. */
export declare function annotatedProperties(inputSchema: unknown): Map<string, string>;
export { headerForm };
