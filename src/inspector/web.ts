/**
 * The inspector's web view: one self-contained page on 127.0.0.1 that shows active
 * subscriptions and every delivered event, live over SSE. Payloads are untrusted, so the
 * page only ever renders them with textContent.
 */
import { createServer, type Server } from "node:http";
import { closeServer, hostForUrl, listen, sendJson } from "../util/http.js";
import { VERSION } from "../version.js";
import type { InspectorStore } from "./store.js";

export interface InspectorWeb {
  url: string;
  close(): Promise<void>;
}

export async function startInspectorWeb(store: InspectorStore, opts: { port?: number; host?: string } = {}): Promise<InspectorWeb> {
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<import("node:http").ServerResponse>();
  let port = 0;

  const server: Server = createServer((req, res) => {
    // DNS-rebinding guard: only answer requests addressed to this loopback listener.
    const reqHost = (req.headers.host ?? "").toLowerCase();
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${hostForUrl(host)}:${port}`];
    if (!allowed.includes(reqHost)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    if (path === "/api/state") return sendJson(res, 200, store.snapshot(), { "cache-control": "no-store" });
    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
      res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/" || path === "/index.html") {
      const html = PAGE.replace("__VERSION__", VERSION);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const onChange = (change: unknown) => {
    const frame = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  store.on("change", onChange);
  const keepalive = setInterval(() => {
    for (const c of clients) c.write(":\n\n");
  }, 15_000);
  keepalive.unref();

  port = await listen(server, opts.port ?? 0, host);
  return {
    url: `http://${hostForUrl(host)}:${port}`,
    async close() {
      clearInterval(keepalive);
      store.off("change", onChange);
      for (const c of clients) c.end();
      await closeServer(server);
    },
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hookbench inspector</title>
<style>
:root{--bg:#fafaf9;--panel:#fff;--text:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#0f766e;--ok:#15803d;--bad:#b91c1c;--warn:#a16207;--code:#f5f5f4}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--panel:#1c1917;--text:#f5f5f4;--muted:#a8a29e;--line:#292524;--accent:#2dd4bf;--ok:#4ade80;--bad:#f87171;--warn:#facc15;--code:#0c0a09}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 20px;align-items:baseline}
h1{font-size:16px;margin:0}h1 span{color:var(--accent)}#server{color:var(--muted);font-size:13px}
main{padding:16px 20px;display:grid;gap:16px;max-width:1200px}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0;padding:10px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 14px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:500}
.wrap{overflow-x:auto}code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.pill{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}
#feed{list-style:none;margin:0;padding:0}#feed li{border-bottom:1px solid var(--line)}
details summary{cursor:pointer;padding:8px 14px;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;list-style:none}
details summary::-webkit-details-marker{display:none}
.body{padding:0 14px 12px}.body pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;max-height:340px;margin:6px 0}
.problems{margin:6px 0;padding-left:18px}.empty{padding:18px 14px;color:var(--muted)}
input{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)}
</style>
</head>
<body>
<header><h1><span>Hookbench</span> inspector</h1><div id="server">connecting…</div><div id="counts" class="muted"></div></header>
<main>
<section><h2>Subscriptions <span id="subcount"></span></h2><div class="wrap"><table><thead><tr><th>Event</th><th>Mode</th><th>Status</th><th>Id</th><th>Cursor</th><th>Timing</th><th>Received</th></tr></thead><tbody id="subs"></tbody></table></div><div id="nosubs" class="empty">No subscriptions yet.</div></section>
<section><h2>Deliveries <input id="filter" placeholder="filter" aria-label="Filter deliveries"></h2><ul id="feed"></ul><div id="nofeed" class="empty">Waiting for events… fire one with <code>hookbench fire &lt;event-name&gt;</code>.</div></section>
</main>
<footer class="muted" style="padding:0 20px 20px;font-size:12px">hookbench __VERSION__ · MCP Events (SEP-3415) · payloads are untrusted and shown as text</footer>
<script>
const $=id=>document.getElementById(id);const subs=new Map();const feed=[];
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e}
function time(iso){return new Date(iso).toLocaleTimeString()}
function json(v){try{return JSON.stringify(v,null,2)}catch(e){return String(v)}}
function renderServer(s){if(!s)return;$('server').textContent=[s.name||'server',s.version,'protocol '+(s.protocolVersion||'?'),'capability: '+(s.capabilityKey||'?'),'profile: '+s.profile,s.url].filter(Boolean).join(' · ')}
function renderSubs(){const tb=$('subs');tb.textContent='';for(const s of subs.values()){const tr=el('tr');
tr.append(el('td',null,s.name),el('td',null,s.mode));const st=el('td');st.append(el('span','pill '+(s.status==='active'?'ok':(s.status==='error'||s.status==='terminated')?'bad':'warn'),s.status));tr.append(st);
tr.append(el('td',null,s.serverId||'-'));const cur=el('td');cur.append(el('code',null,s.cursor===undefined?'-':String(s.cursor)));tr.append(cur);
tr.append(el('td','muted',s.mode==='webhook'?(s.refreshBefore===null?'no expiry':s.refreshBefore?'refresh before '+time(s.refreshBefore):'-'):s.mode==='push'?(s.heartbeatMs?'heartbeat '+s.heartbeatMs+' ms':'-'):(s.nextPollMs?'every '+s.nextPollMs+' ms':'-')));
tr.append(el('td',null,s.received));tb.append(tr)}$('nosubs').style.display=subs.size?'none':'block';$('subcount').textContent=subs.size?String(subs.size):''}
function feedItem(f){const li=el('li');const d=el('details');const sm=el('summary');sm.append(el('span','muted',time(f.at)),el('strong',null,f.name||f.kind),el('span',null,f.mode||''));
const kind=f.kind==='event'?'event':f.kind;sm.append(el('span','pill '+(f.kind==='event'?'ok':f.kind==='error'||f.kind==='rejected'||f.kind==='terminated'?'bad':'warn'),kind));
if(f.eventId)sm.append(el('code','muted',f.eventId));if(f.signature==='verified')sm.append(el('span','ok','signature ✓'));if(f.signature==='invalid')sm.append(el('span','bad','bad signature'));
if(f.duplicate)sm.append(el('span','warn','duplicate'));if(f.problems.length)sm.append(el('span','bad',f.problems.length+' problem'+(f.problems.length>1?'s':'')));if(f.text)sm.append(el('span',null,f.text));
d.append(sm);const b=el('div','body');if(f.problems.length){const ul=el('ul','problems bad');for(const p of f.problems)ul.append(el('li',null,p));b.append(ul)}
if(f.notes.length){const ul=el('ul','problems warn');for(const n of f.notes)ul.append(el('li',null,n));b.append(ul)}
if(f.data!==undefined){b.append(el('div','muted','data'),el('pre',null,json(f.data)))}if(f.body!==undefined){b.append(el('div','muted','payload as delivered'),el('pre',null,typeof f.body==='string'?f.body:json(f.body)))}
if(f.headers){b.append(el('div','muted','headers'),el('pre',null,json(f.headers)))}d.append(b);li.append(d);li.dataset.text=[f.name,f.mode,f.kind,f.eventId,f.text,json(f.data)].join(' ').toLowerCase();return li}
function applyFilter(){const q=$('filter').value.trim().toLowerCase();for(const li of $('feed').children)li.style.display=!q||li.dataset.text.includes(q)?'':'none'}
function addFeed(f){$('feed').prepend(feedItem(f));while($('feed').children.length>300)$('feed').lastChild.remove();$('nofeed').style.display='none';applyFilter()}
function counts(c){if(c)$('counts').textContent=c.events+' events · '+c.problems+' with problems'}
let total={events:0,problems:0};
function onState(s){renderServer(s.server);subs.clear();for(const x of s.subscriptions)subs.set(x.key,x);renderSubs();$('feed').textContent='';for(const f of s.feed)addFeed(f);if(!s.feed.length)$('nofeed').style.display='block';total=s.counts;counts(total)}
function onChange(c){if(c.type==='server')renderServer(c.server);else if(c.type==='subscription'){subs.set(c.subscription.key,c.subscription);renderSubs()}else if(c.type==='feed'){addFeed(c.item);if(c.item.kind==='event')total.events++;if(c.item.problems.length)total.problems++;counts(total)}}
$('filter').addEventListener('input',applyFilter);
const es=new EventSource('/api/events');es.addEventListener('state',e=>onState(JSON.parse(e.data)));es.addEventListener('change',e=>onChange(JSON.parse(e.data)));
es.onerror=()=>{$('server').textContent='disconnected: is hookbench still running?'};
</script>
</body>
</html>`;
