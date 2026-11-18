export class BodyTooLargeError extends Error {
    name = "BodyTooLargeError";
}
/** Read a request body as raw bytes, refusing anything larger than `limit`. */
export function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let failed = false;
        req.on("data", (chunk) => {
            if (failed)
                return;
            size += chunk.length;
            if (size > limit) {
                failed = true;
                reject(new BodyTooLargeError(`body larger than ${limit} bytes`));
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!failed)
                resolve(Buffer.concat(chunks));
        });
        req.on("error", (err) => {
            if (!failed)
                reject(err);
        });
    });
}
export function sendJson(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
        ...headers,
    });
    res.end(text);
}
export function sendEmpty(res, status, headers = {}) {
    res.writeHead(status, headers);
    res.end();
}
/** Lower-cased single-value view of request headers. */
export function headerMap(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined)
            continue;
        out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    }
    return out;
}
/** Start listening and resolve with the bound port. */
export function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve(server.address().port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
    });
}
/** Close a server and every open connection (SSE streams would otherwise hold it open). */
export function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
}
export function hostForUrl(host) {
    return host.includes(":") ? `[${host}]` : host;
}
