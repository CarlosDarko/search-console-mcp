// Utilidades de las páginas HTML (conexión y asistente).

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function mergeHeaders(target: Headers, extra?: Headers): Headers {
  if (!extra) return target;
  for (const cookie of extra.getSetCookie()) target.append('Set-Cookie', cookie);
  extra.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie' && !target.has(key)) target.set(key, value);
  });
  return target;
}

export function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5c6370;--line:#e3e6ea;--accent:#1a73e8;--danger:#c5221f;--ok:#188038}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1f2226;--text:#e8eaed;--muted:#9aa0a6;--line:#33373c;--accent:#8ab4f8;--danger:#f28b82;--ok:#81c995}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px 16px}
main{max-width:600px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.35rem;margin:0 0 12px}p{margin:0 0 14px}.muted{color:var(--muted);font-size:.92rem}
.note{border-left:3px solid var(--accent);padding:8px 12px;margin:0 0 16px;background:color-mix(in srgb,var(--accent) 8%,transparent);border-radius:6px}
.warn{border-left-color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,transparent)}
ul{list-style:none;padding:0;margin:0 0 18px;border:1px solid var(--line);border-radius:10px}
li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid var(--line)}li:first-child{border-top:0}
.email{overflow-wrap:anywhere}.bad{color:var(--danger);font-size:.85rem}
form{margin:0}.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
button{font:inherit;border-radius:8px;padding:10px 16px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}@media (prefers-color-scheme:dark){button.primary{color:#15171a}}
button.link{border:0;padding:4px 8px;color:var(--danger);font-size:.9rem}
h2{font-size:1.1rem;margin:28px 0 8px;padding-top:20px;border-top:1px solid var(--line)}
a{color:var(--accent)}
.copy{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0;overflow-wrap:anywhere;user-select:all}
ol.steps{list-style:none;padding:0;margin:20px 0 0}ol.steps>li{display:flex;align-items:flex-start;justify-content:flex-start;gap:12px;margin:0 0 18px;padding:0;border:0}
.n{flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--card);display:grid;place-items:center;font-size:.85rem;font-weight:600}
ul.sub{margin:8px 0 0;padding-left:18px;border:0;list-style:disc;border-radius:0}ul.sub>li{display:list-item;margin:0 0 4px;padding:0;border:0}
.stack{display:grid;gap:10px;margin-top:10px}label{display:grid;gap:4px;font-size:.92rem}
input,textarea{font:inherit;width:100%;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers },
  );
}
