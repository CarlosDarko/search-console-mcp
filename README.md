# Search Console para Claude

Conector MCP remoto que da a Claude acceso de **solo lectura** a Google Search Console. Cada persona conecta **varias cuentas de Google** y Claude ve juntas las propiedades de todas.

Funciona en claude.ai, en Claude de escritorio y en el móvil, porque se añade a la cuenta de Claude como 'conector personalizado' y no a un ordenador concreto.

## Qué puede hacer Claude con él

| Herramienta | Para qué |
| --- | --- |
| `list_accounts` | Cuentas de Google conectadas y su estado |
| `list_properties` | Todas las propiedades de todas las cuentas, con el permiso y la cuenta que se usa para cada una |
| `search_analytics` | Clics, impresiones, CTR y posición por consulta, página, país, dispositivo, fecha, apariencia u hora, con filtros y comparación entre periodos |
| `inspect_url` | Inspección de URL: indexación, canónica, rastreo, móvil y resultados enriquecidos |
| `list_sitemaps` | Sitemaps enviados, con errores y avisos |

No hace falta saber con qué cuenta se abre cada web. Basta con decir la propiedad (`sc-domain:ejemplo.com`, `https://ejemplo.com/`), un dominio o una URL, y el conector elige la propiedad y la cuenta. Si una propiedad está en varias cuentas, usa la que tenga más permisos.

## Puesta en marcha (una sola vez)

Son tres pasos, y no hay que configurar nada a mano en Cloudflare.

### 1. Publicarlo en Cloudflare (2 minutos)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CarlosDarko/search-console-mcp)

Consejo: abre el botón con **Ctrl+clic** (o **Cmd+clic** en Mac) para no perder esta guía. GitHub no deja que se abra solo en otra pestaña.

1. Pulsa el botón **Deploy to Cloudflare** de aquí arriba. Si no tienes cuenta en Cloudflare, créala, es gratuita.
2. En **Configura tu aplicación**:
   - **Cuenta Git:** pulsa **Nueva conexión GitHub** (o GitLab) y autoriza. Cloudflare creará ahí tu copia del repositorio. Vale una cuenta gratuita.
   - **Crear repositorio Git privado:** márcalo si no quieres que tu copia sea pública. Funciona igual de las dos formas.
   - **Nombre del proyecto:** deja `search-console-mcp`.
   - **Espacio de nombres KV:** deja **+ Crear nuevo** y, en el nombre, escribe `search-console-mcp`.
3. Pulsa **Implementar**.
4. Al terminar, Cloudflare te muestra la dirección del conector. Ábrela.

Si prefieres hacerlo sin el botón, en el panel de Cloudflare ve a **Desarrollo > Cómputo > Workers y Pages**, crea una aplicación eligiendo importar un repositorio y selecciona este (o tu copia).

**¿Cuál es mi dirección?** Es `https://search-console-mcp.` seguido de tu subdominio de Workers. Por ejemplo, si tu subdominio es `ana.workers.dev`, la dirección es `https://search-console-mcp.ana.workers.dev`. Si no la apuntaste, en **Desarrollo > Cómputo > Workers y Pages** entra en `search-console-mcp`: la dirección aparece en su página. Tu subdominio también se ve en la columna derecha de **Workers y Pages**. Si es tu primer Worker, Cloudflare puede pedirte que lo elijas: pon el que quieras.

Cada cambio que llegue a tu copia del repositorio se publica solo.

### 2. El asistente (5 minutos)

En esa dirección aparece un asistente con los enlaces directos a Google y la URI que hay que pegar, ya escrita. Google exige que cada conector tenga su propio cliente OAuth y ese paso no se puede evitar, pero solo lo hace quien publica el conector, una vez:

1. **Activar la API de Search Console** (botón **Habilitar**). Si no tienes proyecto en Google Cloud, te pide crear uno.
2. **Configurar Google Auth Platform** (botón **Comenzar**): nombre de la app y correo, público **Usuarios externos**, correo de contacto y aceptar la política.
3. **Completar Desarrollo de la marca**: página principal (la dirección del conector), política de privacidad (la dirección del conector terminada en `/privacidad`, que el propio conector publica) y dominio autorizado. El asistente te da los tres valores listos para copiar. Sin esto, Google no deja publicar.
4. **Publicar la app** en **Público** (botón **Publicar app**), para que pase de 'Prueba' a 'En producción'. En 'Prueba' solo entran usuarios de prueba y el acceso caduca a los 7 días.
5. **Crear el cliente** de tipo **Aplicación web**, pegando en **URIs de redireccionamiento autorizados** la dirección que te da el asistente.
6. **Pegar el ID y el secreto** en el asistente y entrar con Google. Esa cuenta queda como administradora.

### 3. Añadirlo a Claude (1 minuto)

1. Abre [claude.ai/customize/connectors](https://claude.ai/customize/connectors) (en el menú de claude.ai, **Personalizar > Conectores**) y añade un **conector personalizado**. Nombre: `Search Console`. URL: la dirección del conector terminada en `/mcp` (el asistente te la muestra).
2. Pulsa **Conectar** y entra con una de tus cuentas de Google. Google avisará de que la app no está verificada, porque es tuya: pulsa **Configuración avanzada > Ir a…** y marca la casilla de Search Console.
3. Pulsa **Añadir otra cuenta de Google** por cada cuenta que quieras sumar y, al acabar, **Terminar y volver a Claude**.

El conector aparece en todos los dispositivos donde uses esa cuenta de Claude.

### Añadir o quitar cuentas más adelante

En Claude, desconecta el conector y vuelve a conectarlo. En la página de conexión verás tus cuentas, con botones para quitarlas y para añadir otras. Las que ya estaban se conservan.

## Compartirlo con otras personas

Hay dos formas.

### Que cada persona tenga su propio conector (recomendado si son muchas)

Pásale el enlace de este repositorio y que siga [la puesta en marcha](#puesta-en-marcha-una-sola-vez) desde el botón **Deploy to Cloudflare**. Tendrá su propio Cloudflare y su propio cliente de Google, así que sus datos son suyos y no le afectan el aviso de 'app no verificada' ni el límite de 100 usuarios.

### Que usen tu conector

La persona administradora ve en la página de conexión el apartado **Compartir el conector**. Ahí escribe quién puede usarlo, separado por comas:

- correos concretos: `ana@ejemplo.com, beto@ejemplo.com`
- dominios enteros: `@ejemplo.com`
- cualquiera con cuenta de Google: `*`

Esas personas no tienen que configurar nada. Solo añaden el conector en su Claude con la misma dirección `/mcp` y conectan sus propias cuentas de Google.

**Cada persona solo ve sus cuentas y sus propiedades.** Quien conecta por primera vez empieza con un espacio vacío. Una cuenta de Google pertenece a una sola persona dentro del conector.

Antes de abrirlo a mucha gente, ten en cuenta dos cosas:

- **Límite de Google.** Mientras la app no esté verificada, Google muestra el aviso de 'app no verificada' y la limita a 100 usuarios. Para quitar el aviso y el límite hay que pedir la verificación a Google. El permiso de Search Console es 'sensible', así que piden un dominio verificado con página de inicio y política de privacidad, y un vídeo de demostración. No piden auditoría de seguridad.
- **Datos personales.** Los accesos a las cuentas de Google de esas personas se guardan en tu cuenta de Cloudflare. Eres responsable de ellos (RGPD), así que conviene publicar una política de privacidad.

## Configuración avanzada

Si prefieres no usar el asistente, puedes definir en Cloudflare, en la configuración del Worker `search-console-mcp`, apartado de variables y secretos (tipo **Secreto**), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `ALLOWED_EMAILS`. Si existen, mandan ellas y el asistente no aparece.

Para empezar de cero con el asistente, borra la clave `gsc:config` del espacio KV del Worker (en el panel de Cloudflare, apartado **KV**).

## Seguridad

- Solo lectura: el único permiso de Search Console que se pide es `webmasters.readonly`.
- Los tokens de Google se guardan **cifrados** (AES-GCM) en el espacio KV privado del Worker, con una clave derivada del secreto del cliente OAuth. Si cambias ese secreto, habrá que volver a conectar las cuentas.
- Hasta que se completa el asistente, el conector no acepta conexiones. Una vez completado, el asistente ya no se puede repetir desde la web.
- Claude recibe sus propios tokens (OAuth 2.1 con PKCE), nunca los de Google.
- La página de conexión no se puede incrustar en otra web y sus formularios van ligados al navegador (protección contra 'confused deputy').
- Al quitar una cuenta, también se revoca su acceso en Google.

## Límites del plan gratuito de Cloudflare

Cada consulta de Claude son unas pocas lecturas de KV y ninguna escritura salvo al conectar cuentas o renovar la lista de propiedades (cada 10 minutos). El código no usa listados de KV, que en el plan gratuito son solo 1.000 al día. Con el plan gratuito (100.000 peticiones y 100.000 lecturas al día) hay margen de sobra para una persona y para un grupo pequeño.

## Desarrollo

```bash
npm install
```

```bash
npm test
```

`npm test` comprueba los tipos y lanza `test/e2e.mjs`. Esta prueba arranca el Worker con `wrangler dev` contra un Google simulado (`test/mock-google.mjs`) y recorre todo: el asistente, el registro de Claude, la conexión con varias cuentas, los permisos, la separación entre personas, los tokens y las cinco herramientas.

Para probarlo en local con Google de verdad, lanza `npm run dev -- --local-protocol https` y sigue el asistente en `https://localhost:8787` (las cookies seguras no funcionan con `http`).

| Fichero | Qué hace |
| --- | --- |
| `src/index.ts` | Punto de entrada: OAuth 2.1 para Claude (`@cloudflare/workers-oauth-provider`) |
| `src/setup.ts` | Asistente de la página de inicio |
| `src/config.ts` | Configuración guardada (cliente de Google, administración y lista de acceso) |
| `src/auth.ts` | Página de conexión: consentimiento, inicio de sesión con Google y gestión de cuentas |
| `src/google.ts` | Cuentas, tokens cifrados, API de Search Console y búsqueda de la propiedad |
| `src/mcp.ts` | Servidor MCP (HTTP sin estado, JSON-RPC) y las herramientas |
