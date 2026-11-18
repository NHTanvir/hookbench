import type { JsonObject } from "./types.js";
export declare function validate(value: unknown, schema: unknown, path?: string): string[];
/** A plausible value for a schema: default, const, first enum value, or a typed placeholder. */
export declare function sampleFromSchema(schema: unknown, depth?: number): unknown;
/**
 * Arguments that violate an inputSchema, plus a short description of why,
 * or undefined when the schema accepts everything Hookbench knows how to send.
 */
export declare function invalidArguments(inputSchema: unknown): {
    args: JsonObject;
    why: string;
} | undefined;
