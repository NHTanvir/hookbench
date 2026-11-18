import type { InspectorStore } from "./store.js";
export interface InspectorWeb {
    url: string;
    close(): Promise<void>;
}
export declare function startInspectorWeb(store: InspectorStore, opts?: {
    port?: number;
    host?: string;
}): Promise<InspectorWeb>;
