import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:net";
export declare class BodyTooLargeError extends Error {
    name: string;
}
/** Read a request body as raw bytes, refusing anything larger than `limit`. */
export declare function readBody(req: IncomingMessage, limit: number): Promise<Buffer>;
export declare function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
export declare function sendEmpty(res: ServerResponse, status: number, headers?: Record<string, string>): void;
/** Lower-cased single-value view of request headers. */
export declare function headerMap(req: IncomingMessage): Record<string, string>;
/** Start listening and resolve with the bound port. */
export declare function listen(server: Server, port: number, host: string): Promise<number>;
/** Close a server and every open connection (SSE streams would otherwise hold it open). */
export declare function closeServer(server: Server & {
    closeAllConnections?: () => void;
}): Promise<void>;
export declare function hostForUrl(host: string): string;
