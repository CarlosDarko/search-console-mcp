// Conector MCP de Google Search Console para Claude, en Cloudflare Workers.
// Un solo Worker hace de servidor de autorización (OAuth 2.1 para Claude) y de servidor MCP.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleAuth } from './auth';
import { loadConfig, withConfig } from './config';
import type { Env, GrantProps } from './env';
import { handleSetup, isSetupCallback } from './setup';
import { handleMcp } from './mcp';

const DAY = 86_400;

// La dirección pública del Worker no se conoce hasta desplegarlo: el proveedor se crea con el
// origen de la primera petición (uno por origen, por si el Worker tiene también un dominio propio).
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: {
        fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
          handleMcp(request, env, (ctx as ExecutionContext & { props: GrantProps }).props.owner),
      },
      defaultHandler: { fetch: (request: Request, env: Env) => handleAuth(request, env) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      clientIdMetadataDocumentEnabled: true,
      // Sin escribirlo a mano en cada dispositivo: el acceso dura mientras se use al menos cada 90 días.
      refreshTokenTTL: 90 * DAY,
      refreshTokenIdleTTL: 90 * DAY,
      clientRegistrationTTL: undefined,
      scopesSupported: ['search-console'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        resource_name: 'Google Search Console',
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Página de inicio, asistente de configuración y política de privacidad (sin OAuth de Claude).
    if (url.pathname === '/' || url.pathname === '/setup' || url.pathname === '/privacidad' || isSetupCallback(url)) return handleSetup(request, env);
    const configured = withConfig(env, await loadConfig(env), url.origin);
    return providerFor(url.origin).fetch(request, configured, ctx);
  },
} satisfies ExportedHandler<Env>;
