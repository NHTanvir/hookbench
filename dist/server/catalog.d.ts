/**
 * The reference server's sample event types. Between them they cover all three delivery
 * modes, replayable and emit-only cursors, enums, and an x-mcp-header argument.
 */
import type { DeliveryMode, EventDescriptor, JsonObject } from "../protocol/types.js";
export interface CatalogEntry {
    descriptor: EventDescriptor;
    /** Replayable from a cursor (true) or emit-only with cursor null (false). */
    replay: boolean;
    /** Sample data for the n-th occurrence. */
    sample(n: number): JsonObject;
}
export declare const CATALOG: CatalogEntry[];
/** The catalog as a given dialect serves it (ChatGPT only uses webhook delivery). */
export declare function catalogFor(modes: DeliveryMode[]): CatalogEntry[];
/** Simple argument matching: every argument that is set must equal the payload field of the same name. */
export declare function matchesArguments(data: JsonObject, args: JsonObject | undefined): boolean;
