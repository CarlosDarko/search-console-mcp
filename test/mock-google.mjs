// Google simulado para las pruebas: OAuth, userinfo y la API de Search Console.
// Las URL llegan como /<host>/<ruta> (ver GOOGLE_TEST_BASE en src/google.ts).

import http from 'node:http';

export const USERS = {
  CODE_A: { sub: '111', email: 'ana@ejemplo.com', refresh: 'RA', scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly' },
  CODE_B: { sub: '222', email: 'beto@ejemplo.com', refresh: 'RB', scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly' },
  CODE_X: { sub: '999', email: 'intruso@ejemplo.com', refresh: 'RX', scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly' },
  CODE_C: { sub: '444', email: 'carla@equipo.com', refresh: 'RC', scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly' },
  CODE_NOSCOPE: { sub: '333', email: 'ana@ejemplo.com', refresh: 'RN', scope: 'openid email' },
};

const SITES = {
  '111': [
    { siteUrl: 'sc-domain:ejemplo.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.otro.es/', permissionLevel: 'siteFullUser' },
  ],
  '444': [{ siteUrl: 'sc-domain:carla.com', permissionLevel: 'siteOwner' }],
  '222': [
    { siteUrl: 'https://www.otro.es/', permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:tercero.com', permissionLevel: 'siteRestrictedUser' },
  ],
};

export function startMock(port) {
  const state = { calls: [], revoked: new Set(), tokens: new Map() };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    const who = state.tokens.get(auth);
    state.calls.push({ path, body, who: who?.email });

    if (path === '/oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== 'test-client.apps.googleusercontent.com' || form.get('client_secret') !== 'test-secret') return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const user = USERS[form.get('code')];
        if (!user || !form.get('code_verifier')) return json(400, { error: 'invalid_grant' });
        const access = `AT-${user.sub}-${Math.random()}`;
        state.tokens.set(access, user);
        return json(200, { access_token: access, expires_in: 3600, refresh_token: user.refresh, scope: user.scope, id_token: 'x' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const user = Object.values(USERS).find((u) => u.refresh === form.get('refresh_token'));
        if (!user || state.revoked.has(user.refresh)) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const access = `AT-${user.sub}-${Math.random()}`;
        state.tokens.set(access, user);
        return json(200, { access_token: access, expires_in: 30, scope: user.scope }); // corto: se renueva en cada llamada
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (path === '/oauth2.googleapis.com/revoke') return json(200, {});
    if (!who) return json(401, { error: { message: 'Request had invalid authentication credentials.' } });
    if (path === '/openidconnect.googleapis.com/v1/userinfo') return json(200, { sub: who.sub, email: who.email, email_verified: true });
    if (path === '/www.googleapis.com/webmasters/v3/sites') return json(200, { siteEntry: SITES[who.sub] || [] });

    const m = path.match(/^\/www\.googleapis\.com\/webmasters\/v3\/sites\/([^/]+)\/(searchAnalytics\/query|sitemaps)$/);
    if (m) {
      const site = decodeURIComponent(m[1]);
      if (!(SITES[who.sub] || []).some((s) => s.siteUrl === site)) return json(403, { error: { message: `User does not have sufficient permission for site '${site}'.` } });
      if (m[2] === 'sitemaps') return json(200, { sitemap: [{ path: `${site}sitemap.xml`, errors: '0', warnings: '0' }] });
      const q = JSON.parse(body);
      const prev = q.startDate < '2026-10-01';
      if (!q.dimensions?.length) return json(200, { rows: [{ clicks: prev ? 80 : 100, impressions: 1000, ctr: prev ? 0.08 : 0.1, position: prev ? 9.5 : 8.25 }] });
      return json(200, {
        responseAggregationType: 'byProperty',
        rows: [
          { keys: ['zapatos rojos'], clicks: prev ? 40 : 60, impressions: 500, ctr: prev ? 0.08 : 0.12, position: prev ? 4 : 3.14 },
          { keys: ['botas'], clicks: 40, impressions: 500, ctr: 0.08, position: 12.66 },
          ...(prev ? [] : [{ keys: ['sandalias'], clicks: 1, impressions: 10, ctr: 0.1, position: 20 }]),
        ].slice(0, q.rowLimit),
      });
    }
    if (path === '/searchconsole.googleapis.com/v1/urlInspection/index:inspect') {
      const q = JSON.parse(body);
      if (!(SITES[who.sub] || []).some((s) => s.siteUrl === q.siteUrl)) return json(403, { error: { message: 'no permission' } });
      return json(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS', googleCanonical: q.inspectionUrl } } });
    }
    json(404, { error: { message: `mock: ruta desconocida ${path}` } });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, state })));
}
