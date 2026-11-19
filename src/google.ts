// Cuentas de Google conectadas, sus tokens y las llamadas a la API de Search Console.

import { decrypt, encrypt } from './crypto';
import type { Env } from './env';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/webmasters.readonly',
];
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// Cada persona que usa el conector («titular») tiene sus cuentas de Google, separadas de las demás.
//   gsc:owner:<sub de Google>          → id del titular al que pertenece esa cuenta de Google
//   gsc:u:<titular>:acc:<sub>          → la cuenta (con su token cifrado)
//   gsc:u:<titular>:props              → lista de propiedades (caché de 10 minutos)
const OWNER_PREFIX = 'gsc:owner:';
const accountPrefix = (owner: string) => `gsc:u:${owner}:acc:`;
const propertiesKey = (owner: string) => `gsc:u:${owner}:props`;
const PROPERTIES_TTL = 600;

export interface StoredAccount {
  owner: string;
  sub: string;
  email: string;
  refresh: string; // cifrado
  addedAt: string;
  status: 'ok' | 'revoked';
  error?: string;
}

export interface Property {
  siteUrl: string;
  permissionLevel: string;
  /** Cuenta que se usa para esta propiedad (la de más permisos). */
  account: string;
  /** Todas las cuentas que la ven. */
  accounts: string[];
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

/** Reescribe las URL de Google hacia el servidor falso de las pruebas, si lo hay. */
export function g(env: Env, url: string): string {
  if (!env.GOOGLE_TEST_BASE) return url;
  const u = new URL(url);
  return `${env.GOOGLE_TEST_BASE}/${u.host}${u.pathname}${u.search}`;
}

export function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS || '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Quién puede usar el conector: correos concretos, dominios enteros (@empresa.com) o «*» (cualquiera).
 * Se comprueba con la cuenta con la que se inicia sesión al conectar; las cuentas que esa persona
 * añada después son suyas y no necesitan estar en la lista.
 */
export function isAllowed(env: Env, email: string): boolean {
  const e = email.toLowerCase();
  return allowedEmails(env).some((rule) => rule === '*' || rule === e || (rule.startsWith('@') && e.endsWith(rule)));
}

/** Titular al que ya pertenece una cuenta de Google, si lo hay. */
export async function ownerOf(env: Env, sub: string): Promise<string | null> {
  return env.OAUTH_KV.get(OWNER_PREFIX + sub);
}

// ---------------------------------------------------------------- Inicio de sesión

export function authorizeUrl(env: Env, origin: string, state: string, challenge: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (loginHint) params.set('login_hint', loginHint);
  return g(env, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(env: Env, origin: string, code: string, verifier: string) {
  const res = await fetch(g(env, 'https://oauth2.googleapis.com/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/callback`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const token = (await res.json()) as TokenResponse;
  if (!res.ok || !token.access_token) {
    throw new GoogleError(`Google no aceptó el inicio de sesión: ${token.error_description || token.error || res.status}`, 400);
  }
  const info = await fetch(g(env, 'https://openidconnect.googleapis.com/v1/userinfo'), {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!info.ok) throw new GoogleError('No se pudo leer el correo de la cuenta de Google.', 502);
  const user = (await info.json()) as { sub: string; email: string; email_verified?: boolean };
  const scopes = (token.scope || '').split(' ');
  return {
    sub: user.sub,
    email: (user.email || '').toLowerCase(),
    emailVerified: user.email_verified !== false,
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expiresIn: token.expires_in,
    hasSearchConsole: scopes.includes(GSC_SCOPE),
  };
}

// ---------------------------------------------------------------- Cuentas guardadas

export async function listAccounts(env: Env, owner: string): Promise<StoredAccount[]> {
  const out: StoredAccount[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({ prefix: accountPrefix(owner), cursor });
    for (const key of page.keys) {
      const acc = await env.OAUTH_KV.get<StoredAccount>(key.name, 'json');
      if (acc) out.push(acc);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export async function saveAccount(env: Env, owner: string, sub: string, email: string, refreshToken: string | undefined) {
  const current = await ownerOf(env, sub);
  if (current && current !== owner) {
    throw new GoogleError(`La cuenta ${email} ya está conectada por otra persona en este conector.`, 409);
  }
  const existing = await env.OAUTH_KV.get<StoredAccount>(accountPrefix(owner) + sub, 'json');
  let refresh = existing?.refresh;
  if (refreshToken) refresh = await encrypt(env.GOOGLE_CLIENT_SECRET, refreshToken);
  if (!refresh) {
    throw new GoogleError(
      'Google no devolvió un token de acceso permanente. Quita el acceso de la app en myaccount.google.com/permissions y vuelve a añadir la cuenta.',
      400,
    );
  }
  const account: StoredAccount = {
    owner,
    sub,
    email,
    refresh,
    addedAt: existing?.addedAt || new Date().toISOString(),
    status: 'ok',
  };
  await env.OAUTH_KV.put(accountPrefix(owner) + sub, JSON.stringify(account));
  await env.OAUTH_KV.put(OWNER_PREFIX + sub, owner);
  accessTokens.delete(sub);
  await env.OAUTH_KV.delete(propertiesKey(owner));
}

export async function removeAccount(env: Env, owner: string, sub: string) {
  const acc = await env.OAUTH_KV.get<StoredAccount>(accountPrefix(owner) + sub, 'json');
  if (!acc) return;
  {
    // Revoca el token en Google (si falla, se borra igualmente).
    try {
      const refresh = await decrypt(env.GOOGLE_CLIENT_SECRET, acc.refresh);
      await fetch(g(env, 'https://oauth2.googleapis.com/revoke'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }),
      });
    } catch {
      /* sin importancia */
    }
  }
  await env.OAUTH_KV.delete(accountPrefix(owner) + sub);
  await env.OAUTH_KV.delete(OWNER_PREFIX + sub);
  accessTokens.delete(sub);
  await env.OAUTH_KV.delete(propertiesKey(owner));
}

// Tokens de acceso en memoria (duran una hora; se renuevan con el refresh token).
const accessTokens = new Map<string, { token: string; expires: number }>();

async function accessToken(env: Env, acc: StoredAccount): Promise<string> {
  const hit = accessTokens.get(acc.sub);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
  if (acc.status === 'revoked') {
    throw new GoogleError(`La cuenta ${acc.email} perdió el acceso. Vuelve a añadirla (desconecta y conecta el conector en Claude).`, 401);
  }
  const refresh = await decrypt(env.GOOGLE_CLIENT_SECRET, acc.refresh);
  const res = await fetch(g(env, 'https://oauth2.googleapis.com/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  const token = (await res.json()) as TokenResponse;
  if (!res.ok || !token.access_token) {
    if (token.error === 'invalid_grant') {
      const marked: StoredAccount = { ...acc, status: 'revoked', error: token.error_description || token.error };
      await env.OAUTH_KV.put(accountPrefix(acc.owner) + acc.sub, JSON.stringify(marked));
      await env.OAUTH_KV.delete(propertiesKey(acc.owner));
      throw new GoogleError(
        `Google retiró el acceso de la cuenta ${acc.email}. Vuelve a añadirla (desconecta y conecta el conector en Claude).`,
        401,
      );
    }
    throw new GoogleError(`Google no renovó el acceso de ${acc.email}: ${token.error_description || token.error || res.status}`, 502);
  }
  accessTokens.set(acc.sub, { token: token.access_token, expires: Date.now() + token.expires_in * 1000 });
  return token.access_token;
}

/** Llama a la API de Google con la cuenta indicada. */
export async function call<T>(env: Env, acc: StoredAccount, url: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(env, acc);
  const res = await fetch(g(env, url), {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error_description || text || `HTTP ${res.status}`;
    throw new GoogleError(`Search Console (${acc.email}): ${msg}`, res.status);
  }
  return body as T;
}

// ---------------------------------------------------------------- Propiedades

const RANK: Record<string, number> = {
  siteOwner: 4,
  siteFullUser: 3,
  siteRestrictedUser: 2,
  siteUnverifiedUser: 0,
};

export interface PropertyIndex {
  properties: Property[];
  errors: { account: string; error: string }[];
}

export async function propertyIndex(env: Env, owner: string, fresh = false): Promise<PropertyIndex> {
  if (!fresh) {
    const cachedIndex = await env.OAUTH_KV.get<PropertyIndex>(propertiesKey(owner), 'json');
    if (cachedIndex) return cachedIndex;
  }
  const accounts = await listAccounts(env, owner);
  const map = new Map<string, Property>();
  const errors: PropertyIndex['errors'] = [];
  await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res = await call<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
          env,
          acc,
          'https://www.googleapis.com/webmasters/v3/sites',
        );
        for (const s of res.siteEntry || []) {
          const prev = map.get(s.siteUrl);
          if (!prev) {
            map.set(s.siteUrl, { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel, account: acc.email, accounts: [acc.email] });
            continue;
          }
          prev.accounts.push(acc.email);
          if ((RANK[s.permissionLevel] ?? 1) > (RANK[prev.permissionLevel] ?? 1)) {
            prev.permissionLevel = s.permissionLevel;
            prev.account = acc.email;
          }
        }
      } catch (e) {
        errors.push({ account: acc.email, error: (e as Error).message });
      }
    }),
  );
  const index: PropertyIndex = {
    properties: [...map.values()].sort((a, b) => a.siteUrl.localeCompare(b.siteUrl)),
    errors,
  };
  if (!errors.length) await env.OAUTH_KV.put(propertiesKey(owner), JSON.stringify(index), { expirationTtl: PROPERTIES_TTL });
  return index;
}

function hostOf(text: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function bareHost(host: string): string {
  return host.replace(/^www\./, '');
}

/**
 * Encuentra la propiedad que corresponde a lo que se pidió: el valor exacto
 * (`sc-domain:ejemplo.com`, `https://ejemplo.com/`), un dominio suelto o una URL de página.
 */
export function matchProperty(properties: Property[], input: string): Property | undefined {
  const wanted = input.trim();
  const exact = properties.find((p) => p.siteUrl === wanted) ||
    properties.find((p) => p.siteUrl.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const isUrl = /^[a-z]+:\/\//i.test(wanted);
  const host = bareHost(hostOf(wanted.replace(/^sc-domain:/i, '')));
  // Prefijos de URL que contienen la URL pedida (el más largo gana).
  if (isUrl) {
    const prefixes = properties
      .filter((p) => !p.siteUrl.startsWith('sc-domain:') && wanted.toLowerCase().startsWith(p.siteUrl.toLowerCase()))
      .sort((a, b) => b.siteUrl.length - a.siteUrl.length);
    if (prefixes[0]) return prefixes[0];
  }
  // Propiedad de dominio que cubre el host o uno de sus dominios padre.
  const parts = hostOf(wanted.replace(/^sc-domain:/i, '')).split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join('.');
    const p = properties.find((x) => x.siteUrl.toLowerCase() === `sc-domain:${domain}`);
    if (p) return p;
  }
  // Prefijo de URL con el mismo dominio (https antes que http, con www o sin él).
  const sameHost = properties
    .filter((p) => !p.siteUrl.startsWith('sc-domain:') && bareHost(hostOf(p.siteUrl)) === host)
    .sort((a, b) => Number(b.siteUrl.startsWith('https')) - Number(a.siteUrl.startsWith('https')) || a.siteUrl.length - b.siteUrl.length);
  return sameHost[0];
}

/** Devuelve la propiedad y la cuenta con la que consultarla. */
export async function resolve(env: Env, owner: string, input: string, forceAccount?: string): Promise<{ property: Property; account: StoredAccount }> {
  let index = await propertyIndex(env, owner);
  let property = matchProperty(index.properties, input);
  if (!property) {
    index = await propertyIndex(env, owner, true);
    property = matchProperty(index.properties, input);
  }
  if (!property) {
    throw new GoogleError(
      `No encuentro la propiedad «${input}» en ninguna de las cuentas conectadas. Usa list_properties para ver las que hay.`,
      404,
    );
  }
  const accounts = await listAccounts(env, owner);
  const email = (forceAccount || property.account).toLowerCase();
  if (forceAccount && !property.accounts.includes(email)) {
    throw new GoogleError(`La cuenta ${forceAccount} no tiene acceso a ${property.siteUrl}. La ven: ${property.accounts.join(', ')}.`, 403);
  }
  const account = accounts.find((a) => a.email === email);
  if (!account) throw new GoogleError(`La cuenta ${email} ya no está conectada.`, 404);
  return { property, account };
}
