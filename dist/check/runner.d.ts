import { type ProfileName } from "../protocol/profiles.js";
import type { JsonObject } from "../protocol/types.js";
import { type Level, type RuleDef, type Status } from "./rules.js";
export interface CheckOptions {
    url: string;
    profile?: ProfileName;
    headers?: Record<string, string>;
    /** Public https URL forwarding to Hookbench's local receiver; enables the delivery rules on strict servers. */
    callbackUrl?: string;
    /** The server is configured to accept loopback callbacks (dev mode): skip the private-address rule. */
    allowLoopback?: boolean;
    /** POST {name, data} here to make the server emit an event. */
    triggerUrl?: string;
    /** Or a function that makes the server emit an event. */
    trigger?: (name: string, data: JsonObject) => Promise<void>;
    receiverPort?: number;
    timeoutMs?: number;
    /** How long to wait for an event after triggering one. */
    deliveryWaitMs?: number;
    /** Longest a push stream is watched for heartbeats. */
    streamWatchMs?: number;
    /** heartbeatMs to ask for on events/stream (default 1000). */
    heartbeatMs?: number;
    /** How long to watch for deliveries that should not happen, e.g. after events/unsubscribe (default 1500). */
    settleMs?: number;
    progress?: (line: string) => void;
}
export interface RuleResult {
    id: string;
    title: string;
    level: Level;
    group: RuleDef["group"];
    status: Status;
    detail: string;
    reference: string;
}
export interface CheckReport {
    tool: {
        name: string;
        version: string;
    };
    target: string;
    profile: ProfileName;
    startedAt: string;
    durationMs: number;
    server?: {
        name?: string;
        version?: string;
        era?: string;
        protocolVersion?: string;
        capabilityKey?: string;
    };
    trigger?: string;
    callback?: string;
    results: RuleResult[];
    summary: Record<Status, number>;
    /** No MUST failed. */
    passed: boolean;
}
export declare function runCheck(opts: CheckOptions): Promise<CheckReport>;
