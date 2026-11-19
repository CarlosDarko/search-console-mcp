// Configuración del conector: el cliente OAuth de Google y quién puede usarlo.
// Se guarda desde el asistente de la página de inicio (KV), así no hay que tocar nada en Cloudflare.
// Si existen las variables GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y ALLOWED_EMAILS, mandan ellas.

import type { Env } from './env';

const CONFIG_KEY = 'gsc:config';

export interface StoredConfig {
  clientId: string;
  clientSecret: string;
  /** Quien completó el asistente. Hasta entonces, la configuración se puede rehacer. */
  admin?: string;
  /** Correos, @dominios o «*», separados por comas. */
  allowed?: string;
  updatedAt: string;
}

export interface Config {
  clientId: string;
  clientSecret: string;
  admin?: string;
  allowed: string;
  /** La configuración viene de variables de Cloudflare (no se puede cambiar desde la web). */
  fromEnv: boolean;
}

export async function loadConfig(env: Env): Promise<Config | null> {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, allowed: env.ALLOWED_EMAILS || '', fromEnv: true };
  }
  const stored = await env.OAUTH_KV.get<StoredConfig>(CONFIG_KEY, 'json');
  if (!stored) return null;
  return {
    clientId: stored.clientId,
    clientSecret: stored.clientSecret,
    admin: stored.admin,
    allowed: stored.allowed || '',
    fromEnv: false,
  };
}

export async function storedConfig(env: Env): Promise<StoredConfig | null> {
  return env.OAUTH_KV.get<StoredConfig>(CONFIG_KEY, 'json');
}

export async function saveConfig(env: Env, config: Omit<StoredConfig, 'updatedAt'>) {
  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ ...config, updatedAt: new Date().toISOString() }));
}

/** Copia del entorno con el cliente de Google y la lista de acceso ya resueltos. */
export function withConfig(env: Env, config: Config | null, origin: string, evenIfIncomplete = false): Env {
  // Hasta que se completa el asistente (hay administrador), el conector no acepta conexiones.
  if (!config || (!config.fromEnv && !config.admin && !evenIfIncomplete)) return { ...env, ORIGIN: origin };
  return {
    ...env,
    ORIGIN: origin,
    GOOGLE_CLIENT_ID: config.clientId,
    GOOGLE_CLIENT_SECRET: config.clientSecret,
    ALLOWED_EMAILS: [config.admin, config.allowed].filter(Boolean).join(','),
    ADMIN_EMAIL: config.fromEnv ? undefined : config.admin,
  };
}
