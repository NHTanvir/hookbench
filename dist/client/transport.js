/**
 * Streamable HTTP (2026-07-28): every JSON-RPC message is its own POST, answered with one
 * JSON object or with an SSE stream scoped to that request. Closing the stream cancels it.
 */
import { isObject, isResponse, } from "../protocol/jsonrpc.js";
/** Parse a text/event-stream body. Comment lines (":") are skipped, as the SSE spec says. */
export async function* readSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data = [];
    let event;
    let id;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                const idx = buffer.search(/\r\n|\r|\n/);
                if (idx === -1)
                    break;
                // A lone \r at the end may be the first half of \r\n: wait for more input.
                if (buffer[idx] === "\r" && idx === buffer.length - 1)
                    break;
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + (buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? 2 : 1));
                if (line === "") {
                    if (data.length > 0)
                        yield { event, data: data.join("\n"), id };
                    data = [];
                    event = undefined;
                    id = undefined;
                    continue;
                }
                if (line.startsWith(":"))
                    continue;
                const colon = line.indexOf(":");
                const field = colon === -1 ? line : line.slice(0, colon);
                let val = colon === -1 ? "" : line.slice(colon + 1);
                if (val.startsWith(" "))
                    val = val.slice(1);
                if (field === "data")
                    data.push(val);
                else if (field === "event")
                    event = val;
                else if (field === "id")
                    id = val;
            }
        }
        if (buffer.length > 0 && !buffer.startsWith(":") && buffer.startsWith("data:")) {
            data.push(buffer.slice(5).replace(/^ /, ""));
        }
        if (data.length > 0)
            yield { event, data: data.join("\n"), id };
    }
    finally {
        reader.releaseLock();
    }
}
function linkSignals(timeoutMs, outer) {
    const controller = new AbortController();
    let timer;
    if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    }
    const onAbort = () => controller.abort(outer?.reason);
    if (outer) {
        if (outer.aborted)
            controller.abort(outer.reason);
        else
            outer.addEventListener("abort", onAbort, { once: true });
    }
    return {
        signal: controller.signal,
        controller,
        clear() {
            if (timer)
                clearTimeout(timer);
            outer?.removeEventListener("abort", onAbort);
        },
    };
}
export class TransportError extends Error {
    name = "TransportError";
}
function parseMessage(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** POST one JSON-RPC message and wait for its response (JSON body or SSE stream). */
export async function postRpc(url, message, headers, opts = {}) {
    const linked = linkSignals(opts.timeoutMs ?? 10_000, opts.signal);
    let res;
    try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: linked.signal, redirect: "manual" });
    }
    catch (err) {
        linked.clear();
        throw new TransportError(`could not reach ${url}: ${describeFetchError(err)}`);
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const base = { status: res.status, headers: res.headers, contentType, notifications: [] };
    try {
        if (contentType.includes("text/event-stream") && res.body) {
            const wantId = "id" in message ? message.id : undefined;
            for await (const ev of readSse(res.body)) {
                const parsed = parseMessage(ev.data);
                if (isResponse(parsed) && (wantId === undefined || parsed.id === wantId || parsed.id === null || parsed.id === undefined)) {
                    linked.controller.abort();
                    return { ...base, response: parsed };
                }
                if (isObject(parsed) && typeof parsed["method"] === "string" && !("id" in parsed)) {
                    base.notifications.push(parsed);
                }
            }
            return base;
        }
        const text = await res.text();
        const parsed = text.length > 0 ? parseMessage(text) : undefined;
        if (isResponse(parsed))
            return { ...base, response: parsed };
        return { ...base, bodyText: text.slice(0, 2000) };
    }
    catch (err) {
        if (linked.signal.aborted && linked.signal.reason instanceof Error) {
            throw new TransportError(`${message.method}: ${linked.signal.reason.message}`);
        }
        throw new TransportError(`${message.method}: ${describeFetchError(err)}`);
    }
    finally {
        linked.clear();
    }
}
/** POST a long-lived request (events/stream) and expose the SSE response as messages. */
export async function openRpcStream(url, message, headers, opts = {}) {
    const controller = new AbortController();
    const onOuter = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timed out waiting for the stream to open")), opts.connectTimeoutMs ?? 10_000);
    let res;
    try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal, redirect: "manual" });
    }
    catch (err) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onOuter);
        throw new TransportError(`could not open ${message.method} at ${url}: ${describeFetchError(err)}`);
    }
    clearTimeout(timer);
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const close = () => {
        controller.abort();
        opts.signal?.removeEventListener("abort", onOuter);
    };
    if (!contentType.includes("text/event-stream") || !res.body) {
        const text = await res.text().catch(() => "");
        const parsed = text.length > 0 ? parseMessage(text) : undefined;
        close();
        return {
            status: res.status,
            headers: res.headers,
            contentType,
            response: isResponse(parsed) ? parsed : undefined,
            bodyText: isResponse(parsed) ? undefined : text.slice(0, 2000),
            messages: (async function* () { })(),
            close,
        };
    }
    const body = res.body;
    async function* messages() {
        try {
            for await (const ev of readSse(body)) {
                const parsed = parseMessage(ev.data);
                if (isObject(parsed))
                    yield parsed;
            }
        }
        catch (err) {
            if (!controller.signal.aborted)
                throw err;
        }
    }
    return { status: res.status, headers: res.headers, contentType, messages: messages(), close };
}
export function describeFetchError(err) {
    if (err instanceof Error) {
        const cause = err.cause;
        if (cause instanceof Error) {
            const code = cause.code;
            return code ? `${code} (${cause.message})` : cause.message;
        }
        return err.message;
    }
    return String(err);
}
