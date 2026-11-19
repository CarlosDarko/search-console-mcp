# CLAUDE.md: mantenimiento de este repositorio

Conector MCP remoto de Google Search Console para Claude, en Cloudflare Workers. Es de Carlos Ortega Roldán.

1. **Documentación en castellano.** Todo cambio de comportamiento actualiza en el mismo commit el `README.md` y las pruebas (`test/e2e.mjs` y, si hace falta, `test/mock-google.mjs`).
2. **Antes de push:** `npm test`. Comprueba los tipos y hace la prueba de principio a fin con `wrangler dev` y el Google simulado. GitHub Actions lo repite.
3. **Despliegue:** Cloudflare Workers Builds publica solo lo que llega a la rama principal. No hay que desplegar a mano.
4. **No cambiar sin motivo** el nombre del Worker (`search-console-mcp` en `wrangler.jsonc`), las rutas `/mcp`, `/authorize`, `/callback`, `/token` y `/register`, ni el esquema de claves de KV (`gsc:…`, incluida `gsc:config`). Romperían los conectores ya añadidos en Claude o las cuentas guardadas.
5. **Sin secretos ni datos reales** en el repositorio: nada de ID o secretos de Google, correos reales ni dominios de clientes. Usa `ejemplo.com`.
6. **Solo lectura:** el conector pide únicamente `webmasters.readonly`. Ampliar permisos obliga a que todos vuelvan a conectar sus cuentas, así que hay que avisar antes.
