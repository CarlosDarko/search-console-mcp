// Prueba de principio a fin: arranca el Worker con `wrangler dev` y un Google simulado, y
// recorre lo que hace Claude: registro, autorización con varias cuentas, token y herramientas.
// Uso: npm test

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-google.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // certificado local de wrangler dev
const MOCK_PORT = 9799;
const PORT = 8799;
const ORIGIN = `https://localhost:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function waitReady() {
  try {
    await fetch(`${ORIGIN}/`);
    throw new Error(`El puerto ${PORT} ya está ocupado (¿quedó otro wrangler dev abierto?)`);
  } catch (e) {
    if (String(e.message).includes('ocupado')) throw e;
  }
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${ORIGIN}/`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev no arrancó');
}

// --------------------------------------------------------------- utilidades

const jar = new Map();
async function browser(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { ...(init.headers || {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';');
    const [k, ...v] = pair.split('=');
    const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
    if (expired) jar.delete(k.trim());
    else jar.set(k.trim(), v.join('='));
  }
  return res;
}
const handleOf = (html) => {
  const m = html.match(/name="handle" value="([^"]+)"/);
  assert.ok(m, 'la página debe llevar un handle');
  return m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
};
const post = (handle, fields) =>
  browser(`${ORIGIN}/authorize`, { method: 'POST', body: new URLSearchParams({ handle, ...fields }) });

async function googleLogin(res, code) {
  assert.equal(res.status, 302, 'debe redirigir a Google');
  const loc = new URL(res.headers.get('location'));
  assert.ok(loc.pathname.startsWith('/accounts.google.com/o/oauth2/v2/auth'), loc.href);
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.match(loc.searchParams.get('scope'), /webmasters\.readonly/);
  assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/callback`);
  return browser(`${ORIGIN}/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`);
}

let rpcId = 0;
async function mcp(token, method, params) {
  const res = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  assert.equal(res.status, 200, `${method}: HTTP ${res.status} ${await res.clone().text()}`);
  return (await res.json()).result;
}
async function tool(token, name, args = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  return { ...r, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
}
const step = (t) => console.log('·', t);

// --------------------------------------------------------------- recorrido

async function run() {
  step('el código no usa KV.list (el plan gratuito solo da 1.000 listados al día)');
  for (const f of fs.readdirSync('src')) {
    assert.doesNotMatch(fs.readFileSync(path.join('src', f), 'utf8'), /OAUTH_KV\.list\(/, `src/${f} usa OAUTH_KV.list`);
  }

  step('descubrimiento OAuth y 401 sin token');
  const unauth = await fetch(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata=/);
  const prm = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${ORIGIN}/mcp`);
  const asm = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(asm.registration_endpoint, `${ORIGIN}/register`);

  step('registro dinámico del cliente (como Claude)');
  const reg = await (await fetch(`${ORIGIN}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
  })).json();
  assert.ok(reg.client_id, JSON.stringify(reg));

  let res;
  step('antes de configurar, la conexión avisa');
  {
    const v0 = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 's0', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    const r0 = await fetch(`${ORIGIN}/authorize?${v0}`);
    assert.equal(r0.status, 503);
    assert.match(await r0.text(), /aún no está configurado/);
  }

  step('asistente: muestra la URI de redirección y valida el ID');
  res = await browser(`${ORIGIN}/`);
  let wiz = await res.text();
  assert.match(wiz, /Configurar el conector/);
  assert.ok(wiz.includes(`${ORIGIN}/callback`));
  res = await browser(`${ORIGIN}/setup`, { method: 'POST', body: new URLSearchParams({ client_id: 'nada', client_secret: 'test-secret' }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no parece correcto/);

  step('asistente: un secreto equivocado se detecta al comprobar con Google');
  res = await browser(`${ORIGIN}/setup`, { method: 'POST', body: new URLSearchParams({ client_id: 'test-client.apps.googleusercontent.com', client_secret: 'secreto-malo' }) });
  {
    const loc = new URL(res.headers.get('location'));
    res = await browser(`${ORIGIN}/callback?code=CODE_A&state=${loc.searchParams.get('state')}`);
    assert.match(await res.text(), /Google no aceptó el ID o el secreto/);
  }

  step('asistente: guarda el cliente y la cuenta que comprueba queda como administradora');
  res = await browser(`${ORIGIN}/setup`, { method: 'POST', body: new URLSearchParams({ client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-secret' }) });
  res = await googleLogin(res, 'CODE_A');
  wiz = await res.text();
  assert.match(wiz, /Todo listo\. ana@ejemplo\.com queda como administradora/);
  assert.ok(wiz.includes(`${ORIGIN}/mcp`));
  res = await browser(`${ORIGIN}/setup`, { method: 'POST', body: new URLSearchParams({ client_id: 'otro.apps.googleusercontent.com', client_secret: 'xxxxxxxxxxxx' }) });
  assert.match(await res.text(), /ya está configurado/);
  jar.clear();

  step('página de consentimiento');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 'st-123', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
  res = await browser(`${ORIGIN}/authorize?${q}`);
  let html = await res.text();
  assert.equal(res.status, 200, html);
  assert.match(html, /Continuar con Google/);
  assert.match(html, /claude\.ai/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');

  step('un formulario falso sin la cookie del navegador se rechaza');
  const forged = await fetch(`${ORIGIN}/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ handle: handleOf(html), decision: 'approve' }) });
  assert.notEqual(forged.status, 302);

  step('una cuenta no permitida no puede empezar');
  // (se prueba en otra pestaña con su propio flujo)
  {
    const r1 = await browser(`${ORIGIN}/authorize?${q}`);
    const h1 = handleOf(await r1.text());
    const r2 = await googleLogin(await post(h1, { decision: 'approve' }), 'CODE_X');
    const t2 = await r2.text();
    assert.equal(r2.status, 403, t2);
    assert.match(t2, /intruso@ejemplo\.com no tiene permiso/);
  }

  step('primera cuenta (ana)');
  res = await googleLogin(await post(handleOf(html), { decision: 'approve' }), 'CODE_A');
  html = await res.text();
  assert.equal(res.status, 200, html);
  assert.match(html, /Cuenta ana@ejemplo\.com conectada/);
  assert.match(html, /Terminar y volver a Claude/);

  step('el mismo handle no sirve dos veces');
  const h = handleOf(html);
  res = await googleLogin(await post(h, { decision: 'add' }), 'CODE_B');
  html = await res.text();
  const reuse = await post(h, { decision: 'finish' });
  assert.notEqual(reuse.status, 302);

  step('segunda cuenta (beto) y lista con las dos');
  assert.match(html, /Cuenta beto@ejemplo\.com conectada/);
  assert.match(html, /ana@ejemplo\.com/);

  step('la administradora comparte el conector con un dominio');
  assert.match(html, /Compartir el conector/);
  res = await post(handleOf(html), { decision: 'share', allowed: '@equipo.com; basura, ' });
  html = await res.text();
  assert.match(html, /Guardado\. Pueden usar el conector: @equipo\.com\./);

  step('otra persona (carla, permitida por dominio) conecta lo suyo en su propio espacio');
  let carlaToken;
  {
    const saved = new Map(jar);
    jar.clear();
    const v2 = crypto.randomBytes(32).toString('base64url');
    const q2 = new URLSearchParams({ ...Object.fromEntries(q), state: 'st-c', code_challenge: crypto.createHash('sha256').update(v2).digest('base64url') });
    let rc = await browser(`${ORIGIN}/authorize?${q2}`);
    rc = await googleLogin(await post(handleOf(await rc.text()), { decision: 'approve' }), 'CODE_C');
    const hc = await rc.text();
    assert.match(hc, /Cuenta carla@equipo\.com conectada/);
    assert.doesNotMatch(hc, /ana@ejemplo\.com/, 'carla no debe ver las cuentas de ana');
    assert.doesNotMatch(hc, /Compartir el conector/, 'solo la administradora puede compartir');
    rc = await post(handleOf(hc), { decision: 'finish' });
    const codeC = new URL(rc.headers.get('location')).searchParams.get('code');
    const tc = await (await fetch(`${ORIGIN}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: codeC, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: v2, resource: `${ORIGIN}/mcp` }) })).json();
    carlaToken = tc.access_token;
    assert.ok(carlaToken, JSON.stringify(tc));
    jar.clear();
    for (const [k, v] of saved) jar.set(k, v);
  }

  step('una cuenta que ya es de otra persona no se puede añadir');
  res = await googleLogin(await post(handleOf(html), { decision: 'add' }), 'CODE_C');
  html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /carla@equipo\.com ya está conectada por otra persona/);

  step('sin permiso de Search Console no se guarda');
  res = await googleLogin(await post(handleOf(html), { decision: 'add' }), 'CODE_NOSCOPE');
  html = await res.text();
  assert.match(html, /No se dio permiso para leer Search Console/);

  step('cancelar en Google dentro del flujo vuelve a la lista');
  {
    const r = await post(handleOf(html), { decision: 'add' });
    const loc = new URL(r.headers.get('location'));
    const back = await browser(`${ORIGIN}/callback?error=access_denied&state=${encodeURIComponent(loc.searchParams.get('state'))}`);
    html = await back.text();
    assert.match(html, /Se canceló el inicio de sesión/);
  }

  step('terminar: vuelve a Claude con un código');
  res = await post(handleOf(html), { decision: 'finish' });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st-123');
  const code = back.searchParams.get('code');
  assert.ok(code);

  step('canje del código por token');
  const tok = await (await fetch(`${ORIGIN}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  })).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  assert.ok(tok.refresh_token);
  const T = tok.access_token;

  step('MCP: initialize, notificación y tools/list');
  const init = await mcp(T, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'search-console-mcp');
  const note = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const list = await mcp(T, 'tools/list', {});
  assert.deepEqual(list.tools.map((t) => t.name), ['list_accounts', 'list_properties', 'search_analytics', 'inspect_url', 'list_sitemaps']);

  step('list_properties junta las dos cuentas y elige la de más permisos');
  let r = await tool(T, 'list_properties');
  assert.equal(r.isError, false, r.data);
  assert.equal(r.data.count, 3);
  const otro = r.data.properties.find((p) => p.site_url === 'https://www.otro.es/');
  assert.equal(otro.account, 'beto@ejemplo.com');
  assert.deepEqual(otro.also_in, ['ana@ejemplo.com']);
  assert.equal(r.data.properties.find((p) => p.site_url === 'sc-domain:ejemplo.com').account, 'ana@ejemplo.com');

  step('carla solo ve sus propiedades');
  {
    const rc = await tool(carlaToken, 'list_properties');
    assert.deepEqual(rc.data.properties.map((p) => p.site_url), ['sc-domain:carla.com']);
    const denied = await tool(carlaToken, 'search_analytics', { site_url: 'ejemplo.com' });
    assert.equal(denied.isError, true);
    assert.match(denied.data, /No encuentro la propiedad/);
  }

  step('list_accounts');
  r = await tool(T, 'list_accounts');
  assert.deepEqual(r.data.accounts.map((a) => [a.email, a.properties]), [['ana@ejemplo.com', 2], ['beto@ejemplo.com', 2]]);

  step('search_analytics con dominio suelto, filtros y comparación');
  state.calls.length = 0;
  r = await tool(T, 'search_analytics', {
    site_url: 'otro.es', start_date: '2026-10-01', end_date: '2026-10-28', compare_start_date: '2026-09-03', compare_end_date: '2026-09-30',
    dimensions: ['query'], filters: [{ dimension: 'country', operator: 'equals', expression: 'esp' }], row_limit: 10,
  });
  assert.equal(r.isError, false, r.data);
  assert.equal(r.data.property, 'https://www.otro.es/');
  assert.equal(r.data.account, 'beto@ejemplo.com');
  assert.deepEqual(r.data.totals, { clicks: 100, impressions: 1000, ctr: 10, position: 8.3 });
  assert.deepEqual(r.data.totals_change, { clicks: 20, impressions: 0, ctr: 2, position: -1.2 });
  assert.deepEqual(r.data.rows[0], { query: 'zapatos rojos', clicks: 60, impressions: 500, ctr: 12, position: 3.1, prev: { clicks: 40, impressions: 500, ctr: 8, position: 4 }, change: { clicks: 20, impressions: 0, ctr: 4, position: -0.9 } });
  assert.equal(r.data.rows[2].prev, null);
  const sent = state.calls.filter((c) => c.path.endsWith('searchAnalytics/query')).map((c) => JSON.parse(c.body));
  assert.ok(sent.every((b) => b.dimensionFilterGroups[0].filters[0].expression === 'esp'));
  assert.ok(state.calls.filter((c) => c.path.endsWith('searchAnalytics/query')).every((c) => c.who === 'beto@ejemplo.com'));

  step('search_analytics con fechas por defecto y cuenta forzada');
  r = await tool(T, 'search_analytics', { site_url: 'https://www.otro.es/blog/post', account: 'ana@ejemplo.com' });
  assert.equal(r.isError, false, r.data);
  assert.equal(r.data.account, 'ana@ejemplo.com');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.data.period.end_date));
  r = await tool(T, 'search_analytics', { site_url: 'sc-domain:tercero.com', account: 'ana@ejemplo.com' });
  assert.equal(r.isError, true);
  assert.match(r.data, /no tiene acceso/);

  step('errores claros');
  r = await tool(T, 'search_analytics', { site_url: 'noexiste.com' });
  assert.equal(r.isError, true);
  assert.match(r.data, /No encuentro la propiedad/);
  r = await tool(T, 'search_analytics', { site_url: 'ejemplo.com', start_date: '28/10/2026' });
  assert.match(r.data, /AAAA-MM-DD/);

  step('inspect_url encuentra la propiedad de dominio de un subdominio');
  r = await tool(T, 'inspect_url', { url: 'https://blog.tercero.com/x' });
  assert.equal(r.isError, false, r.data);
  assert.equal(r.data.property, 'sc-domain:tercero.com');
  assert.equal(r.data.result.indexStatusResult.verdict, 'PASS');

  step('list_sitemaps');
  r = await tool(T, 'list_sitemaps', { site_url: 'ejemplo.com' });
  assert.equal(r.data.sitemaps[0].path, 'sc-domain:ejemplo.comsitemap.xml');

  step('token de Claude renovable');
  const ref = await (await fetch(`${ORIGIN}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id, resource: `${ORIGIN}/mcp` }),
  })).json();
  assert.ok(ref.access_token, JSON.stringify(ref));
  r = await tool(ref.access_token, 'list_accounts');
  assert.equal(r.isError, false);

  step('quitar una cuenta en una conexión nueva');
  jar.clear();
  res = await browser(`${ORIGIN}/authorize?${q}`);
  res = await googleLogin(await post(handleOf(await res.text()), { decision: 'approve' }), 'CODE_A');
  html = await res.text();
  const sub = html.match(/name="sub" value="222"/);
  assert.ok(sub, 'debe ofrecer quitar a beto');
  res = await post(handleOf(html), { decision: 'remove', sub: '222' });
  html = await res.text();
  assert.match(html, /Se quitó la cuenta beto@ejemplo\.com/);
  assert.doesNotMatch(html, /name="sub" value="222"/);
  r = await tool(ref.access_token, 'list_properties');
  assert.equal(r.data.count, 2);

  step('cuenta revocada en Google: aviso claro y estado «sin acceso»');
  state.revoked.add('RA'); // el token en memoria de ana se borró al volver a iniciar sesión
  r = await tool(ref.access_token, 'search_analytics', { site_url: 'ejemplo.com' });
  assert.equal(r.isError, true);
  assert.match(r.data, /Google retiró el acceso de la cuenta ana@ejemplo\.com/);
  r = await tool(ref.access_token, 'list_accounts');
  assert.match(r.data.accounts[0].status, /sin acceso/);
}

// --------------------------------------------------------------- arranque

let server, state;
({ server, state } = await startMock(MOCK_PORT));
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-mcp-'));
const worker = spawn(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--port', String(PORT), '--local-protocol', 'https', '--persist-to', persist,
    '--compatibility-flags', 'nodejs_compat',
    '--var', `GOOGLE_TEST_BASE:http://127.0.0.1:${MOCK_PORT}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);
let log = '';
worker.stdout.on('data', (d) => (log += d));
worker.stderr.on('data', (d) => (log += d));

let failed = false;
try {
  await waitReady();
  await run();
  console.log('\nOK: todas las comprobaciones pasaron.');
} catch (e) {
  failed = true;
  console.error('\nFALLO:', e);
  console.error('\n--- registro de wrangler ---\n' + log.slice(-4000));
} finally {
  try {
    process.kill(-worker.pid, 'SIGTERM'); // todo el grupo: wrangler y workerd
  } catch {}
  server.close();
  fs.rmSync(persist, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
