// Asistente de la página de inicio: se pega el cliente OAuth de Google y se comprueba entrando
// con Google. Quien lo completa queda como administrador. No hace falta tocar nada en Cloudflare.

import { loadConfig, saveConfig, storedConfig, withConfig, type Config } from './config';
import { pkceChallenge, randomToken } from './crypto';
import type { Env } from './env';
import { authorizeUrl, exchangeCode, GoogleError } from './google';
import { esc, page } from './ui';

const STATE_PREFIX = 'setup_';
const COOKIE = '__Host-gsc-setup';

export function isSetupCallback(url: URL): boolean {
  return url.pathname === '/callback' && (url.searchParams.get('state') || '').startsWith(STATE_PREFIX);
}

/** Dominio que hay que autorizar en Google: el dominio registrable (con workers.dev, el subdominio de la cuenta). */
export function authorizedDomain(host: string): string {
  const parts = host.split('.');
  return parts.slice(host.endsWith('.workers.dev') ? -3 : -2).join('.');
}

function privacyPage(origin: string, admin?: string): Response {
  return page(
    'Política de privacidad',
    `<h1>Política de privacidad</h1>
<p class="muted">Conector de Google Search Console para Claude publicado en ${esc(origin)}.</p>
<h2>Qué datos usa</h2>
<p>Cuando conectas el conector, inicias sesión con tus cuentas de Google y das permiso de <strong>solo lectura</strong> a Google Search Console (<em>webmasters.readonly</em>), además de tu dirección de correo para identificarte.</p>
<p>Con ese permiso, el conector lee los datos de Search Console de tus propiedades (rendimiento en búsqueda, inspección de URL y sitemaps) <strong>solo cuando tú se lo pides</strong> a Claude, y se los entrega a tu sesión de Claude.</p>
<h2>Qué se guarda</h2>
<ul class="sub"><li>Tu correo y un identificador de cada cuenta de Google que conectes.</li>
<li>El token de acceso de Google de cada cuenta, cifrado.</li>
<li>Durante 10 minutos, la lista de tus propiedades, para responder más rápido.</li></ul>
<p>No se guardan los datos de rendimiento ni las consultas: se piden a Google en el momento y no se almacenan. No se venden ni se ceden a terceros, ni se usan para publicidad.</p>
<p>Todo se guarda en la cuenta de Cloudflare de quien administra este conector. Cada persona solo puede ver sus propias cuentas y propiedades.</p>
<h2>Cómo borrar tus datos</h2>
<p>Desconecta el conector en Claude y vuelve a conectarlo: en la página de conexión puedes <strong>quitar</strong> cada cuenta, lo que borra sus datos y revoca el acceso en Google. También puedes retirar el acceso cuando quieras en <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.</p>
<p>El uso de los datos recibidos de las API de Google cumple la <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">política de datos de usuario de los servicios de API de Google</a>, incluidos los requisitos de uso limitado.</p>
${admin ? `<h2>Contacto</h2><p>${esc(admin)}</p>` : ''}`,
  );
}

const isComplete = (c: Config | null) => Boolean(c && (c.fromEnv || c.admin));

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function readyPage(origin: string, admin?: string, intro?: string): Response {
  return page(
    'Search Console para Claude',
    `<h1>Search Console para Claude</h1>
${intro ? `<p class="note">${esc(intro)}</p>` : ''}
<p>Para usarlo, abre <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener">los conectores de Claude</a> (<strong>Personalizar > Conectores</strong>), añade un <strong>conector personalizado</strong> llamado <em>Search Console</em> y pon esta dirección:</p>
<p class="copy">${esc(origin)}/mcp</p>
<p>Al pulsar <strong>Conectar</strong>, entra con tu cuenta de Google y añade las demás que quieras.${admin ? ' Desde esa misma página puedes compartir el conector con otras personas.' : ''}</p>
${admin ? `<p class="muted">Administración: ${esc(admin)}.</p>` : ''}
<p class="muted"><a href="/privacidad">Política de privacidad</a></p>`,
  );
}

function wizard(origin: string, error?: string, clientId = ''): Response {
  const redirect = `${origin}/callback`;
  const step = (n: number, html: string) => `<li><span class="n">${n}</span><div>${html}</div></li>`;
  return page(
    'Configurar Search Console para Claude',
    `<h1>Configurar el conector</h1>
<p>Google pide que cada conector tenga su propia 'llave' (un cliente OAuth). Se crea una sola vez, en unos 5 minutos, siguiendo estos pasos en orden. Abre cada enlace con la cuenta de Google que quieras usar como administradora.</p>
${error ? `<p class="note warn">${esc(error)}</p>` : ''}
<ol class="steps">
${step(1, `<a href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noopener">Abre la API de Search Console</a> y pulsa <strong>Habilitar</strong>. Si Google te pide antes un proyecto, crea uno con cualquier nombre (por ejemplo, <em>search-console-claude</em>) y vuelve a este enlace.`)}
${step(2, `<a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Abre Google Auth Platform</a> y pulsa <strong>Comenzar</strong>. Se abre un formulario de cuatro partes:<ul class="sub"><li><strong>Información de la app</strong>: nombre <em>Search Console para Claude</em> y, como correo de asistencia, el tuyo. <strong>Siguiente</strong>.</li><li><strong>Público</strong>: <strong>Usuarios externos</strong>. <strong>Siguiente</strong>.</li><li><strong>Información de contacto</strong>: tu correo. <strong>Siguiente</strong>.</li><li><strong>Finalizar</strong>: acepta la política de datos de usuario, <strong>Continuar</strong> y <strong>Crear</strong>.</li></ul>`)}
${step(3, `<a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">Abre Desarrollo de la marca</a>. Google no deja publicar la app sin estos datos. Rellena:<ul class="sub">
<li><strong>Página principal de la aplicación</strong>:<p class="copy">${esc(origin)}</p></li>
<li><strong>Vínculo a la Política de Privacidad</strong>:<p class="copy">${esc(origin)}/privacidad</p></li>
<li><strong>Dominios autorizados</strong>: pulsa <strong>Agregar un dominio</strong> y pega:<p class="copy">${esc(authorizedDomain(new URL(origin).hostname))}</p></li>
<li>Comprueba que llevan tu correo el <strong>Correo de asistencia al usuario</strong> y, abajo del todo, la <strong>Información de contacto del desarrollador</strong>. Deja vacíos el logotipo y las condiciones del servicio.</li></ul>
Pulsa <strong>Guardar</strong>.`)}
${step(4, `<a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Abre Público</a>, pulsa <strong>Publicar app</strong> y confirma. El estado debe pasar de <em>Prueba</em> a <em>En producción</em>. No te lo saltes: en <em>Prueba</em> Google solo deja entrar a usuarios de prueba y corta el acceso a los 7 días.`)}
${step(5, `<a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Crea el cliente</a>: en <strong>Tipo de aplicación</strong> elige <strong>Aplicación web</strong> (el nombre da igual). En <strong>URIs de redireccionamiento autorizados</strong> añade una URI y pega exactamente esto:<p class="copy">${esc(redirect)}</p>Pulsa <strong>Crear</strong>. Google te mostrará el <strong>ID de cliente</strong> y el <strong>Secreto del cliente</strong>. <strong>Copia el secreto en ese momento</strong>: Google no lo vuelve a enseñar. Si se te pasa, entra en el cliente y, en <strong>Secretos del cliente</strong>, pulsa <strong>Agregar secreto</strong> para crear otro.`)}
${step(6, `Copia el <strong>ID de cliente</strong> y el <strong>Secreto del cliente</strong> y pégalos aquí:
<form method="post" action="/setup" class="stack">
<label>ID de cliente<input name="client_id" required autocomplete="off" spellcheck="false" value="${esc(clientId)}" placeholder="123-abc.apps.googleusercontent.com"></label>
<label>Secreto del cliente<input name="client_secret" required autocomplete="off" spellcheck="false" type="password" placeholder="GOCSPX-…"></label>
<div class="row"><button class="primary">Guardar y comprobar con Google</button></div>
</form>
<p class="muted">Te pedirá entrar con Google. Esa cuenta quedará como administradora. Google avisará de que <em>no ha verificado esta app</em>, porque es tuya y nueva: pulsa <strong>Configuración avanzada</strong>, luego <strong>Ir a Search Console para Claude (no seguro)</strong> y después <strong>Continuar</strong>. Si aparece una casilla para ver tus datos de Search Console, márcala.</p>`)}
</ol>`,
    error ? 400 : 200,
  );
}

export async function handleSetup(request: Request, rawEnv: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = await loadConfig(rawEnv);

  try {
    if (url.pathname === '/privacidad' && request.method === 'GET') {
      return privacyPage(url.origin, config?.fromEnv ? undefined : config?.admin);
    }

    if (url.pathname === '/' && request.method === 'GET') {
      if (isComplete(config)) return readyPage(url.origin, config?.fromEnv ? undefined : config?.admin);
      return wizard(url.origin);
    }

    if (url.pathname === '/setup' && request.method === 'POST') {
      if (isComplete(config)) return readyPage(url.origin, undefined, 'El conector ya está configurado.');
      const form = await request.formData();
      const clientId = String(form.get('client_id') || '').trim();
      const clientSecret = String(form.get('client_secret') || '').trim();
      if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
        return wizard(url.origin, 'El ID de cliente no parece correcto: termina en .apps.googleusercontent.com.', clientId);
      }
      if (clientSecret.length < 10) return wizard(url.origin, 'Falta el secreto del cliente.', clientId);
      await saveConfig(rawEnv, { clientId, clientSecret });
      const env = withConfig(rawEnv, await loadConfig(rawEnv), url.origin, true);
      const state = STATE_PREFIX + randomToken(24);
      const verifier = randomToken(48);
      await rawEnv.OAUTH_KV.put(`gsc:setup:${state}`, verifier, { expirationTtl: 900 });
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl(env, url.origin, state, await pkceChallenge(verifier)),
          'Set-Cookie': `${COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`,
        },
      });
    }

    if (isSetupCallback(url)) {
      if (isComplete(config)) return readyPage(url.origin, undefined, 'El conector ya está configurado.');
      const state = url.searchParams.get('state') || '';
      const verifier = await rawEnv.OAUTH_KV.get(`gsc:setup:${state}`);
      if (!verifier || cookieValue(request, COOKIE) !== state) {
        return wizard(url.origin, 'La comprobación ha caducado o se abrió en otro navegador. Vuelve a pegar el ID y el secreto.', config?.clientId);
      }
      await rawEnv.OAUTH_KV.delete(`gsc:setup:${state}`);
      if (url.searchParams.get('error')) {
        return wizard(url.origin, 'Se canceló el inicio de sesión con Google. Vuelve a intentarlo.', config?.clientId);
      }
      const env = withConfig(rawEnv, config, url.origin, true);
      let user;
      try {
        user = await exchangeCode(env, url.origin, url.searchParams.get('code') || '', verifier);
      } catch (e) {
        return wizard(url.origin, `Google no aceptó el ID o el secreto. Revisa que los copiaste bien. (${(e as Error).message})`, config?.clientId);
      }
      const stored = await storedConfig(rawEnv);
      if (!stored) return wizard(url.origin);
      await saveConfig(rawEnv, { ...stored, admin: user.email });
      const headers = new Headers({ 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
      const res = readyPage(url.origin, user.email, `Todo listo. ${user.email} queda como administradora del conector.`);
      res.headers.append('Set-Cookie', headers.get('Set-Cookie')!);
      return res;
    }

    return new Response('Not Found', { status: 404 });
  } catch (e) {
    if (e instanceof GoogleError) return wizard(url.origin, e.message);
    throw e;
  }
}
