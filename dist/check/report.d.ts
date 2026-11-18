import type { CheckReport } from "./runner.js";
export declare function exitCodeFor(report: CheckReport, strict?: boolean): number;
export declare function formatText(report: CheckReport, color: boolean): string;
export declare function formatMarkdown(report: CheckReport): string;
export declare function formatJson(report: CheckReport): string;
