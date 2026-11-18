export type Level = "MUST" | "SHOULD" | "INTEROP";
export type Status = "pass" | "fail" | "warn" | "skip" | "info";
export interface RuleDef {
    id: string;
    title: string;
    level: Level;
    group: "discovery" | "list" | "errors" | "poll" | "push" | "webhook" | "delivery" | "interop";
    reference: string;
}
export declare const RULES: RuleDef[];
export declare const RULE_IDS: string[];
export declare function ruleById(id: string): RuleDef;
