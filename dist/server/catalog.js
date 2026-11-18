const TITLES = [
    "Checkout returns a 500 for EU cards",
    "Password reset email never arrives",
    "Dashboard chart is empty after midnight UTC",
    "CSV export drops the last row",
];
const PRIORITIES = ["normal", "high", "urgent", "low"];
const PROJECTS = ["web", "api"];
const BRANCHES = ["main", "release/1.4"];
const SERVICES = ["payments", "search", "auth"];
const SEVERITIES = ["P2", "P1", "P3", "P4"];
function pick(list, n) {
    return list[n % list.length];
}
export const CATALOG = [
    {
        replay: true,
        descriptor: {
            name: "ticket.created",
            description: "Fires when a support ticket is opened.",
            delivery: ["poll", "push", "webhook"],
            inputSchema: {
                type: "object",
                properties: {
                    priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Only tickets with this priority." },
                    project: { type: "string", description: "Only tickets in this project." },
                },
                additionalProperties: false,
            },
            payloadSchema: {
                type: "object",
                required: ["ticketId", "title", "priority", "project"],
                properties: {
                    ticketId: { type: "string" },
                    title: { type: "string" },
                    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
                    project: { type: "string" },
                    url: { type: "string", format: "uri" },
                },
            },
        },
        sample: (n) => ({
            ticketId: `T-${1001 + n}`,
            title: pick(TITLES, n),
            priority: pick(PRIORITIES, n),
            project: pick(PROJECTS, n),
            url: `https://tickets.example.com/T-${1001 + n}`,
        }),
    },
    {
        replay: true,
        descriptor: {
            name: "build.finished",
            description: "Fires when a CI build completes.",
            delivery: ["poll", "push"],
            inputSchema: {
                type: "object",
                properties: {
                    branch: { type: "string", description: "Only builds of this branch.", "x-mcp-header": "Branch" },
                    status: { type: "string", enum: ["passed", "failed"], description: "Only builds that ended this way." },
                },
                additionalProperties: false,
            },
            payloadSchema: {
                type: "object",
                required: ["buildId", "branch", "status", "durationMs"],
                properties: {
                    buildId: { type: "string" },
                    branch: { type: "string" },
                    status: { type: "string", enum: ["passed", "failed"] },
                    durationMs: { type: "integer", minimum: 0 },
                },
            },
        },
        sample: (n) => ({
            buildId: `b-${4800 + n}`,
            branch: pick(BRANCHES, n),
            status: n % 3 === 2 ? "failed" : "passed",
            durationMs: 61_000 + n * 7_300,
        }),
    },
    {
        replay: false,
        descriptor: {
            name: "alert.fired",
            description: "Fires when a monitoring alert triggers. Emit-only: no replay, cursor is null.",
            delivery: ["push", "webhook"],
            inputSchema: {
                type: "object",
                properties: {
                    severity: { type: "string", enum: ["P1", "P2", "P3", "P4"], description: "Only alerts of this severity." },
                },
                additionalProperties: false,
            },
            payloadSchema: {
                type: "object",
                required: ["alertId", "severity", "service", "summary"],
                properties: {
                    alertId: { type: "string" },
                    severity: { type: "string", enum: ["P1", "P2", "P3", "P4"] },
                    service: { type: "string" },
                    summary: { type: "string" },
                },
            },
        },
        sample: (n) => ({
            alertId: `A-${700 + n}`,
            severity: pick(SEVERITIES, n),
            service: pick(SERVICES, n),
            summary: `${pick(SERVICES, n)} p99 latency above 2 s for 5 minutes`,
        }),
    },
];
/** The catalog as a given dialect serves it (ChatGPT only uses webhook delivery). */
export function catalogFor(modes) {
    return CATALOG.map((entry) => ({
        ...entry,
        descriptor: {
            ...entry.descriptor,
            delivery: entry.descriptor.delivery.filter((m) => modes.includes(m)).length > 0
                ? entry.descriptor.delivery.filter((m) => modes.includes(m))
                : modes.slice(0, 1),
        },
    }));
}
/** Simple argument matching: every argument that is set must equal the payload field of the same name. */
export function matchesArguments(data, args) {
    if (!args)
        return true;
    return Object.entries(args).every(([k, v]) => v === undefined || v === null || data[k] === v);
}
