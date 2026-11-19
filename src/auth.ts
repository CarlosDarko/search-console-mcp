// Página de conexión: Claude pide acceso, se inicia sesión con Google y se eligen las cuentas.

import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import { pkceChallenge, randomToken, sha256 } from './crypto';
import { storedConfig, saveConfig } from './config';
import { esc, mergeHeaders, page } from './ui';
import type { Env, GrantProps } from './env';
import { authorizeUrl, exchangeCode, GoogleError, isAllowed, listAccounts, ownerOf, removeAccount, saveAccount } from './google';

const FLOW_PREFIX = 'gsc:flow:';

/** Persona identificada en este flujo: su id de titular y el correo con el que entró. */
interface Verified {
  owner: string;
  email: string;
}

interface UpstreamData {
  verifier: string;
  /** Quién ha iniciado sesión ya en este flujo (null antes del primer inicio de sesión). */
  verified: Verified | null;
}

function clientLine(clientName: string, redirectHost: string, loopback: boolean): string {
  return `<p class="muted">Aplicación: <strong>${esc(clientName)}</strong>. El acceso se enviará a <strong>${esc(redirectHost)}</strong>.</p>${
    loopback ? '<p class="note warn">El acceso irá a una aplicación de este ordenador. Sigue solo si acabas de conectar desde ella.</p>' : ''
  }`;
}

/** Paso 1: Claude (u otra app) pide acceso. Se pide confirmación y luego se va a Google. */
async function showConsent(env: Env, req: AuthRequest): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const details = await oauth.describeConsent(req);
  const consent = await oauth.beginConsent(req);
  return page(
    'Conectar Search Console',
    `<h1>Conectar Google Search Console</h1>
${clientLine(details.clientName, details.redirectHost, details.redirectIsLoopback)}
<p>Para continuar, inicia sesión con una de tus cuentas de Google. Después podrás añadir el resto.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(consent.handle)}">
<div class="row"><button class="primary" name="decision" value="approve">Continuar con Google</button>
<button name="decision" value="deny">Cancelar</button></div></form>`,
    200,
    consent.headers,
  );
}

/** Paso 2 (y siguientes): cuentas conectadas, con añadir, quitar y terminar. */
async function showAccounts(env: Env, req: AuthRequest, verified: Verified, headers: Headers | undefined, message?: { text: string; warn?: boolean }): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const details = await oauth.describeConsent(req);
  const consent = await oauth.beginConsent(req);
  await env.OAUTH_KV.put(FLOW_PREFIX + (await sha256(consent.handle)), JSON.stringify({ verified }), { expirationTtl: 900 });
  const accounts = await listAccounts(env, verified.owner);
  const handle = `<input type="hidden" name="handle" value="${esc(consent.handle)}">`;
  const list = accounts.length
    ? `<ul>${accounts
        .map(
          (a) => `<li><span class="email">${esc(a.email)}${a.status !== 'ok' ? ' <span class="bad">· sin acceso, vuelve a añadirla</span>' : ''}</span>
<form method="post" action="/authorize">${handle}<input type="hidden" name="sub" value="${esc(a.sub)}"><button class="link" name="decision" value="remove">Quitar</button></form></li>`,
        )
        .join('')}</ul>`
    : '<p class="note warn">Aún no hay ninguna cuenta conectada.</p>';
  const hasOk = accounts.some((a) => a.status === 'ok');
  const isAdmin = Boolean(env.ADMIN_EMAIL) && verified.email === env.ADMIN_EMAIL;
  const shared = isAdmin ? (await storedConfig(env))?.allowed || '' : '';
  const shareForm = isAdmin
    ? `<h2>Compartir el conector</h2>
<p class="muted">Quién más puede usarlo con sus propias cuentas, separado por comas: correos (ana@ejemplo.com), dominios enteros (@ejemplo.com) o * para cualquiera. Cada persona solo ve lo suyo. Déjalo vacío para usarlo solo tú.</p>
<form method="post" action="/authorize">${handle}<textarea name="allowed" rows="2" placeholder="ana@ejemplo.com, @ejemplo.com">${esc(shared)}</textarea>
<div class="row"><button name="decision" value="share">Guardar</button></div></form>
<p class="muted">Para usarlo, cada persona añade en Claude un conector personalizado con esta dirección: <strong>${esc(env.ORIGIN || '')}/mcp</strong></p>`
    : '';
  return page(
    'Cuentas de Google',
    `<h1>Cuentas de Google conectadas</h1>
${message ? `<p class="note${message.warn ? ' warn' : ''}">${esc(message.text)}</p>` : ''}
${list}
<p class="muted">Claude verá las propiedades de Search Console de todas estas cuentas. Has iniciado sesión como ${esc(verified.email)}.</p>
${clientLine(details.clientName, details.redirectHost, details.redirectIsLoopback)}
<form method="post" action="/authorize">${handle}
<div class="row">${hasOk ? '<button class="primary" name="decision" value="finish">Terminar y volver a Claude</button>' : ''}
<button${hasOk ? '' : ' class="primary"'} name="decision" value="add">Añadir otra cuenta de Google</button>
<button name="decision" value="deny">Cancelar</button></div></form>
${shareForm}`,
    200,
    mergeHeaders(consent.headers, headers),
  );
}

async function startGoogle(env: Env, origin: string, req: AuthRequest, verified: Verified | null, headers: Headers): Promise<Response> {
  const verifier = randomToken(48);
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(req, { data: { verifier, verified } satisfies UpstreamData, headers });
  upstream.headers.set('Location', authorizeUrl(env, origin, upstream.state, await pkceChallenge(verifier)));
  return new Response(null, { status: 302, headers: upstream.headers });
}

function errorPage(text: string, status = 400): Response {
  return page('No se pudo conectar', `<h1>No se pudo conectar</h1><p>${esc(text)}</p><p class="muted">Vuelve a Claude y prueba a conectar otra vez.</p>`, status);
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return errorPage(`El conector aún no está configurado. Abre ${url.origin} y sigue el asistente.`, 503);
    }

    if (url.pathname === '/authorize' && request.method === 'GET') {
      return await showConsent(env, await oauth.parseAuthRequest(request));
    }

    if (url.pathname === '/authorize' && request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      const decision = String(form.get('decision') || '');
      const flowKey = FLOW_PREFIX + (await sha256(handle));
      const flow = await env.OAUTH_KV.get<{ verified: Verified }>(flowKey, 'json');
      if (decision === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        await env.OAUTH_KV.delete(flowKey);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      await env.OAUTH_KV.delete(flowKey);

      // Primera confirmación: aún no se sabe quién es. Siempre se pasa por Google.
      if (!flow) return await startGoogle(env, url.origin, approved.request, null, approved.headers);

      switch (decision) {
        case 'add':
          return await startGoogle(env, url.origin, approved.request, flow.verified, approved.headers);
        case 'remove': {
          const sub = String(form.get('sub') || '');
          const gone = (await listAccounts(env, flow.verified.owner)).find((a) => a.sub === sub);
          if (gone) await removeAccount(env, flow.verified.owner, sub);
          return await showAccounts(env, approved.request, flow.verified, approved.headers, gone ? { text: `Se quitó la cuenta ${gone.email}.` } : undefined);
        }
        case 'finish': {
          const accounts = await listAccounts(env, flow.verified.owner);
          if (!accounts.some((a) => a.status === 'ok')) {
            return await showAccounts(env, approved.request, flow.verified, approved.headers, { text: 'Añade al menos una cuenta antes de terminar.', warn: true });
          }
          const props: GrantProps = { owner: flow.verified.owner, email: flow.verified.email };
          const { redirectTo } = await oauth.completeAuthorization({
            request: approved.request,
            userId: flow.verified.owner,
            metadata: { email: flow.verified.email },
            scope: approved.request.scope,
            props,
          });
          approved.headers.set('Location', redirectTo);
          return new Response(null, { status: 302, headers: approved.headers });
        }
        case 'share': {
          const stored = await storedConfig(env);
          if (!stored || !env.ADMIN_EMAIL || flow.verified.email !== env.ADMIN_EMAIL) {
            return await showAccounts(env, approved.request, flow.verified, approved.headers, { text: 'Solo la persona administradora puede cambiar esto.', warn: true });
          }
          const allowed = String(form.get('allowed') || '')
            .split(/[,\s;]+/)
            .map((x) => x.trim().toLowerCase())
            .filter((x) => x === '*' || /^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(x))
            .join(', ');
          await saveConfig(env, { ...stored, allowed });
          return await showAccounts(env, approved.request, flow.verified, approved.headers, {
            text: allowed ? `Guardado. Pueden usar el conector: ${allowed}.` : 'Guardado. Solo tú puedes usar el conector.',
          });
        }
        default:
          return await showAccounts(env, approved.request, flow.verified, approved.headers);
      }
    }

    if (url.pathname === '/callback' && request.method === 'GET') {
      const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
      const googleError = url.searchParams.get('error');
      if (googleError) {
        if (data.verified) {
          return await showAccounts(env, original, data.verified, headers, { text: 'Se canceló el inicio de sesión en Google.', warn: true });
        }
        headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
        return new Response(null, { status: 302, headers });
      }
      const user = await exchangeCode(env, url.origin, url.searchParams.get('code') || '', data.verifier);
      if (!user.emailVerified) {
        const text = `Google no ha verificado el correo ${user.email}.`;
        if (data.verified) return await showAccounts(env, original, data.verified, headers, { text, warn: true });
        return errorPage(text, 403);
      }
      let verified = data.verified;
      if (!verified) {
        // Primer inicio de sesión: identifica a la persona. Si esta cuenta ya era de alguien,
        // es esa persona; si no, empieza un espacio nuevo con ella.
        if (!isAllowed(env, user.email)) {
          return errorPage(`La cuenta ${user.email} no tiene permiso para usar este conector. Pide acceso a quien lo administra.`, 403);
        }
        verified = { owner: (await ownerOf(env, user.sub)) || crypto.randomUUID(), email: user.email };
      } else {
        const holder = await ownerOf(env, user.sub);
        if (holder && holder !== verified.owner) {
          return await showAccounts(env, original, verified, headers, {
            text: `La cuenta ${user.email} ya está conectada por otra persona en este conector.`,
            warn: true,
          });
        }
      }
      if (!user.hasSearchConsole) {
        return await showAccounts(env, original, verified, headers, {
          text: `No se dio permiso para leer Search Console con ${user.email}. Vuelve a añadirla y marca la casilla de Search Console.`,
          warn: true,
        });
      }
      await saveAccount(env, verified.owner, user.sub, user.email, user.refreshToken);
      return await showAccounts(env, original, verified, headers, { text: `Cuenta ${user.email} conectada.` });
    }

    return new Response('Not Found', { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return errorPage(`${error.description || 'La página ha caducado o ya se usó.'}`);
    if (error instanceof CimdFetchError) return errorPage('No se pudo verificar la aplicación que pide acceso.');
    if (error instanceof GoogleError) return errorPage(error.message, error.status >= 400 && error.status < 600 ? error.status : 400);
    throw error;
  }
}
