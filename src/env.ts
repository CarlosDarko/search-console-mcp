import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  // Lo normal es no definir estas tres variables: el asistente de la página de inicio guarda la
  // configuración en KV. Si se definen como secretos en Cloudflare, mandan ellas.
  /** ID de cliente OAuth de Google (tipo «Aplicación web»). */
  GOOGLE_CLIENT_ID: string;
  /** Secreto de ese cliente OAuth. */
  GOOGLE_CLIENT_SECRET: string;
  /**
   * Quién puede usar el conector, separado por comas: correos (ana@ejemplo.com), dominios
   * (@ejemplo.com) o «*» para cualquiera con cuenta de Google.
   */
  ALLOWED_EMAILS: string;
  /** Persona administradora (la que completó el asistente). Lo pone el Worker. */
  ADMIN_EMAIL?: string;
  /** Origen público del Worker (https://…). Lo pone el Worker en cada petición. */
  ORIGIN?: string;
  /**
   * Solo para las pruebas locales: si existe, todas las llamadas a Google van a
   * `${GOOGLE_TEST_BASE}/<host>/<ruta>` (un servidor falso). En producción no se define.
   */
  GOOGLE_TEST_BASE?: string;
}

/** Lo que guarda cada concesión de Claude (props cifradas por la librería). */
export interface GrantProps {
  /** Titular: la persona cuyas cuentas de Google ve esta conexión. */
  owner: string;
  /** Correo con el que se inició sesión al conectar Claude. */
  email: string;
}
