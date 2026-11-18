/** Render a CheckReport for a terminal, for a GitHub step summary (Markdown), or as JSON. */
import { padEnd, palette } from "../util/color.js";
import type { Status } from "./rules.js";
import type { CheckReport, RuleResult } from "./runner.js";

const SYMBOL: Record<Status, string> = { pass: "✓", fail: "✗", warn: "!", skip: "–", info: "i" };
const GROUPS: Array<[RuleResult["group"], string]> = [
  ["discovery", "Discovery and capability"],
  ["list", "events/list"],
  ["errors", "Errors and routing headers"],
  ["poll", "Poll delivery (events/poll)"],
  ["push", "Push delivery (events/stream)"],
  ["webhook", "Webhook subscriptions (events/subscribe, events/unsubscribe)"],
  ["delivery", "Webhook deliveries"],
  ["interop", "Interop"],
];

export function exitCodeFor(report: CheckReport, strict = false): number {
  if (report.summary.fail > 0) return 1;
  if (strict && report.summary.warn > 0) return 1;
  return 0;
}

export function formatText(report: CheckReport, color: boolean): string {
  const c = palette(color);
  const paint = (s: Status, text: string) =>
    s === "pass" ? c.green(text) : s === "fail" ? c.red(text) : s === "warn" ? c.yellow(text) : s === "info" ? c.blue(text) : c.gray(text);
  const lines: string[] = [];
  lines.push(`${c.bold("hookbench check")}  ${report.target}  ${c.dim(`(profile ${report.profile})`)}`);
  if (report.server) {
    const s = report.server;
    lines.push(c.dim(`server   ${[s.name && `${s.name}${s.version ? ` ${s.version}` : ""}`, s.protocolVersion && `protocol ${s.protocolVersion}`, s.era === "legacy" && "initialize handshake", s.capabilityKey && `capability: ${s.capabilityKey}`].filter(Boolean).join(" · ")}`));
  }
  if (report.trigger) lines.push(c.dim(`trigger  ${report.trigger}`));
  if (report.callback) lines.push(c.dim(`callback ${report.callback}`));
  for (const [group, title] of GROUPS) {
    const rows = report.results.filter((r) => r.group === group);
    if (rows.length === 0) continue;
    lines.push("", c.bold(title));
    for (const r of rows) {
      const tag = paint(r.status, `${SYMBOL[r.status]} ${r.status.toUpperCase().padEnd(4)}`);
      lines.push(`  ${tag}  ${padEnd(r.id, 28)} ${r.title}${r.level === "SHOULD" ? c.dim(" (SHOULD)") : ""}`);
      if (r.detail) lines.push(`         ${" ".repeat(28)} ${r.status === "pass" || r.status === "skip" ? c.dim(r.detail) : r.detail}`);
      if (r.status === "fail" || r.status === "warn") lines.push(`         ${" ".repeat(28)} ${c.dim(r.reference)}`);
    }
  }
  const s = report.summary;
  lines.push("");
  lines.push(
    `${report.results.length} rules: ${c.green(`${s.pass} pass`)} · ${s.fail ? c.red(`${s.fail} fail`) : `${s.fail} fail`} · ${s.warn ? c.yellow(`${s.warn} warn`) : `${s.warn} warn`} · ${s.skip} skip · ${s.info} info  ${c.dim(`(${(report.durationMs / 1000).toFixed(1)} s)`)}`,
  );
  lines.push(report.passed ? c.green(c.bold("PASS")) + c.dim(" no MUST requirement failed") : c.red(c.bold("FAIL")) + c.dim(` ${s.fail} MUST requirement(s) failed`));
  return lines.join("\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatMarkdown(report: CheckReport): string {
  const s = report.summary;
  const icon: Record<Status, string> = { pass: "✅", fail: "❌", warn: "⚠️", skip: "⏭️", info: "ℹ️" };
  const out: string[] = [];
  out.push(`### ${report.passed ? "✅" : "❌"} MCP Events conformance: ${report.passed ? "passed" : "failed"} (${report.profile})`);
  out.push("");
  out.push(`\`${report.target}\` · ${s.pass} pass · ${s.fail} fail · ${s.warn} warn · ${s.skip} skip · checked by [Hookbench](https://github.com/NHTanvir/hookbench) ${report.tool.version}`);
  out.push("");
  out.push("| | Rule | Level | Detail |");
  out.push("| --- | --- | --- | --- |");
  for (const r of report.results) {
    const id = r.status === "fail" || r.status === "warn" ? `[\`${r.id}\`](${r.reference})` : `\`${r.id}\``;
    out.push(`| ${icon[r.status]} | ${id} ${cell(r.title)} | ${r.level} | ${cell(r.detail)} |`);
  }
  return out.join("\n");
}

export function formatJson(report: CheckReport): string {
  return JSON.stringify(report, null, 2);
}
