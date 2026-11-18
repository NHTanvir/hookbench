import { type ProfileName } from "../protocol/profiles.js";
import type { DeliveryMode, JsonObject } from "../protocol/types.js";
/** How to run Hookbench from npm until it is published under a public name. */
export declare const RUN: string;
export interface Io {
    out: {
        write(s: string): unknown;
        isTTY?: boolean;
    };
    err: {
        write(s: string): unknown;
        isTTY?: boolean;
    };
}
export declare const defaultIo: Io;
export declare function useColor(io: Io, noColor: boolean): boolean;
export declare function parseProfile(v: string | undefined): ProfileName;
export declare function parseMode(v: string, flag?: string): DeliveryMode | "auto";
export declare function parseJsonObject(text: string, what: string): JsonObject;
export declare function readJsonFile(path: string, what: string): JsonObject;
export declare function requireUrl(raw: string | undefined, what: string): string;
/** Resolve when the process is asked to stop (Ctrl+C or SIGTERM). */
export declare function untilInterrupted(): Promise<string>;
