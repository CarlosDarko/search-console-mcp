// Servidor MCP (transporte HTTP «streamable», sin estado, respuestas JSON).

import type { Env } from './env';
import { call, GoogleError, listAccounts, propertyIndex, resolve } from './google';

const SERVER_INFO = { name: 'search-console-mcp', title: 'Google Search Console', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Datos de Google Search Console de todas las cuentas de Google que ha conectado esta persona.
- Empieza con list_properties para ver las propiedades y con qué cuenta se abre cada una.
- En el resto de herramientas basta con site_url: el valor exacto (sc-domain:ejemplo.com, https://ejemplo.com/) o un dominio o URL, y el conector elige la propiedad y la cuenta.
- Los datos de Search Console llegan con 2 o 3 días de retraso: por defecto se usan los últimos 28 días completos.
- Las fechas son AAAA-MM-DD en la zona horaria del Pacífico (la de Search Console).`;

const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance', 'hour'];
const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'];
const TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];

const siteUrlProp = {
  type: 'string',
  description: 'Propiedad: sc-domain:ejemplo.com, https://ejemplo.com/ o simplemente ejemplo.com o una URL suya.',
};
const accountProp = {
  type: 'string',
  description: 'Opcional: correo de la cuenta de Google con la que consultar, si la propiedad está en varias.',
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: 'list_accounts',
    title: 'Cuentas conectadas',
    description: 'Lista las cuentas de Google conectadas, su estado y cuántas propiedades ve cada una.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'list_properties',
    title: 'Propiedades de Search Console',
    description:
      'Lista todas las propiedades de Search Console de todas las cuentas conectadas, con el nivel de permiso y la cuenta con la que se consultan.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Opcional: texto que debe contener la propiedad (por ejemplo, un dominio).' },
        refresh: { type: 'boolean', description: 'Volver a pedir la lista a Google en vez de usar la de los últimos 10 minutos.' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'search_analytics',
    title: 'Rendimiento en búsqueda',
    description:
      'Clics, impresiones, CTR y posición media de una propiedad, agrupados por las dimensiones que pidas (consulta, página, país, dispositivo, fecha, apariencia, hora), con filtros y, opcionalmente, comparando con otro periodo. Las filas llegan ordenadas por clics. Siempre devuelve también los totales del periodo.',
    inputSchema: {
      type: 'object',
      properties: {
        site_url: siteUrlProp,
        start_date: { type: 'string', description: 'AAAA-MM-DD. Por defecto, 28 días antes de end_date.' },
        end_date: { type: 'string', description: 'AAAA-MM-DD. Por defecto, hace 3 días (el último día con datos completos).' },
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: DIMENSIONS },
          description: 'Agrupación. Vacío: solo totales. «hour» solo admite los últimos días.',
        },
        filters: {
          type: 'array',
          description: 'Filtros que se cumplen todos a la vez.',
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', enum: ['query', 'page', 'country', 'device', 'searchAppearance'] },
              operator: { type: 'string', enum: OPERATORS, default: 'contains' },
              expression: {
                type: 'string',
                description: 'Valor. País en ISO 3166-1 alfa-3 (esp, mex…). Dispositivo: DESKTOP, MOBILE, TABLET. Regex en sintaxis RE2.',
              },
            },
            required: ['dimension', 'expression'],
            additionalProperties: false,
          },
        },
        search_type: { type: 'string', enum: TYPES, description: 'Por defecto, web.' },
        row_limit: { type: 'integer', minimum: 1, maximum: 25000, description: 'Filas (por defecto 100, máximo 25.000).' },
        start_row: { type: 'integer', minimum: 0, description: 'Para paginar: fila desde la que empezar.' },
        aggregation_type: {
          type: 'string',
          enum: ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'],
          description: 'Cómo agrega Google (por defecto, auto).',
        },
        data_state: {
          type: 'string',
          enum: ['final', 'all', 'hourly_all'],
          description: 'final: solo datos cerrados. all: incluye los recientes, aún provisionales. hourly_all: necesario con «hour».',
        },
        compare_start_date: { type: 'string', description: 'Opcional: inicio del periodo con el que comparar (AAAA-MM-DD).' },
        compare_end_date: { type: 'string', description: 'Opcional: fin del periodo con el que comparar (AAAA-MM-DD).' },
        account: accountProp,
      },
      required: ['site_url'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'inspect_url',
    title: 'Inspeccionar URL',
    description:
      'Inspección de URL de Search Console: si está indexada, la canónica elegida por Google y la declarada, el último rastreo, robots, móvil, AMP y resultados enriquecidos.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL completa que inspeccionar.' },
        site_url: { type: 'string', description: 'Opcional: propiedad. Si no se indica, se busca la que contiene la URL.' },
        language: { type: 'string', description: 'Idioma de los mensajes (por defecto, es).' },
        account: accountProp,
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_sitemaps',
    title: 'Sitemaps',
    description: 'Sitemaps enviados a una propiedad, con su estado, errores, avisos y URL enviadas.',
    inputSchema: {
      type: 'object',
      properties: { site_url: siteUrlProp, account: accountProp },
      required: ['site_url'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

// ---------------------------------------------------------------- Herramientas

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(name: string, value: string) {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) throw new GoogleError(`${name} debe ser una fecha AAAA-MM-DD.`, 400);
}

const enc = (s: string) => encodeURIComponent(s);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

interface Row {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function shapeRow(dimensions: string[], row: Row) {
  const out: Record<string, string | number> = {};
  dimensions.forEach((d, i) => (out[d] = row.keys?.[i] ?? ''));
  out.clicks = row.clicks;
  out.impressions = row.impressions;
  out.ctr = round(row.ctr * 100, 2);
  out.position = round(row.position, 1);
  return out;
}

async function searchAnalytics(env: Env, owner: string, args: any) {
  const { property, account } = await resolve(env, owner, String(args.site_url || ''), args.account);
  const end = args.end_date || ymd(new Date(Date.now() - 3 * DAY));
  checkDate('end_date', end);
  const start = args.start_date || ymd(new Date(Date.parse(end) - 27 * DAY));
  checkDate('start_date', start);
  if (start > end) throw new GoogleError('start_date no puede ser posterior a end_date.', 400);
  const dimensions: string[] = Array.isArray(args.dimensions) ? args.dimensions : [];
  for (const d of dimensions) if (!DIMENSIONS.includes(d)) throw new GoogleError(`Dimensión no válida: ${d}.`, 400);
  const rowLimit = Math.min(Math.max(Number(args.row_limit) || 100, 1), 25000);
  const filters = (Array.isArray(args.filters) ? args.filters : []).map((f: any) => {
    const operator = f.operator || 'contains';
    if (!OPERATORS.includes(operator)) throw new GoogleError(`Operador no válido: ${operator}.`, 400);
    return { dimension: f.dimension, operator, expression: String(f.expression) };
  });
  const dataState = args.data_state || (dimensions.includes('hour') ? 'hourly_all' : undefined);

  const base = {
    type: args.search_type || 'web',
    ...(filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters }] } : {}),
    ...(args.aggregation_type ? { aggregationType: args.aggregation_type } : {}),
    ...(dataState ? { dataState } : {}),
  };
  const url = `https://www.googleapis.com/webmasters/v3/sites/${enc(property.siteUrl)}/searchAnalytics/query`;
  const query = (body: object) => call<{ rows?: Row[]; responseAggregationType?: string }>(env, account, url, {
    method: 'POST',
    body: JSON.stringify({ ...base, ...body }),
  });

  const totalsOf = async (s: string, e: string) => {
    const r = await query({ startDate: s, endDate: e });
    const row = r.rows?.[0];
    return row ? shapeRow([], row) : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  };

  const [current, totals] = await Promise.all([
    dimensions.length
      ? query({ startDate: start, endDate: end, dimensions, rowLimit, startRow: Number(args.start_row) || 0 })
      : Promise.resolve({ rows: [] as Row[], responseAggregationType: undefined }),
    totalsOf(start, end),
  ]);
  const rows = current.rows || []; // Google las ordena por clics

  const result: Record<string, unknown> = {
    property: property.siteUrl,
    account: account.email,
    search_type: base.type,
    period: { start_date: start, end_date: end },
    totals,
  };
  if (current.responseAggregationType) result.aggregation = current.responseAggregationType;

  if (args.compare_start_date || args.compare_end_date) {
    const cs = args.compare_start_date;
    const ce = args.compare_end_date;
    if (!cs || !ce) throw new GoogleError('Para comparar hacen falta compare_start_date y compare_end_date.', 400);
    checkDate('compare_start_date', cs);
    checkDate('compare_end_date', ce);
    const prevLimit = Math.min(25000, Math.max(rowLimit * 5, 1000));
    const [prev, prevTotals] = await Promise.all([
      dimensions.length ? query({ startDate: cs, endDate: ce, dimensions, rowLimit: prevLimit }) : Promise.resolve({ rows: [] as Row[] }),
      totalsOf(cs, ce),
    ]);
    const byKey = new Map((prev.rows || []).map((r) => [JSON.stringify(r.keys), r]));
    result.compare_period = { start_date: cs, end_date: ce };
    result.compare_totals = prevTotals;
    result.totals_change = {
      clicks: (totals.clicks as number) - (prevTotals.clicks as number),
      impressions: (totals.impressions as number) - (prevTotals.impressions as number),
      ctr: round((totals.ctr as number) - (prevTotals.ctr as number), 2),
      position: round((totals.position as number) - (prevTotals.position as number), 1),
    };
    result.rows = rows.map((r) => {
      const now = shapeRow(dimensions, r);
      const before = byKey.get(JSON.stringify(r.keys));
      if (!before) return { ...now, prev: null };
      const p = shapeRow([], before);
      return {
        ...now,
        prev: p,
        change: {
          clicks: r.clicks - before.clicks,
          impressions: r.impressions - before.impressions,
          ctr: round((now.ctr as number) - (p.ctr as number), 2),
          position: round((now.position as number) - (p.position as number), 1),
        },
      };
    });
    result.note =
      'ctr en %. prev = null: sin datos de esa fila en el periodo anterior (o fuera de las primeras filas consultadas). En position, un cambio negativo es una mejora.';
  } else {
    result.rows = rows.map((r) => shapeRow(dimensions, r));
    result.note = 'ctr en %.';
  }
  if (dimensions.length) {
    result.row_count = rows.length;
    result.more_rows_possible = rows.length === rowLimit;
  }
  return result;
}

async function inspectUrl(env: Env, owner: string, args: any) {
  const url = String(args.url || '');
  if (!/^https?:\/\//i.test(url)) throw new GoogleError('url debe ser una URL completa (https://…).', 400);
  const { property, account } = await resolve(env, owner, args.site_url || url, args.account);
  const res = await call<{ inspectionResult?: unknown }>(
    env,
    account,
    'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
    {
      method: 'POST',
      body: JSON.stringify({ inspectionUrl: url, siteUrl: property.siteUrl, languageCode: args.language || 'es' }),
    },
  );
  return { property: property.siteUrl, account: account.email, url, result: res.inspectionResult ?? res };
}

async function listSitemaps(env: Env, owner: string, args: any) {
  const { property, account } = await resolve(env, owner, String(args.site_url || ''), args.account);
  const res = await call<{ sitemap?: any[] }>(
    env,
    account,
    `https://www.googleapis.com/webmasters/v3/sites/${enc(property.siteUrl)}/sitemaps`,
  );
  return { property: property.siteUrl, account: account.email, sitemaps: res.sitemap || [] };
}

async function listProperties(env: Env, owner: string, args: any) {
  const index = await propertyIndex(env, owner, Boolean(args.refresh));
  const filter = String(args.filter || '').toLowerCase();
  const properties = index.properties
    .filter((p) => !filter || p.siteUrl.toLowerCase().includes(filter))
    .map((p) => ({
      site_url: p.siteUrl,
      permission: p.permissionLevel,
      account: p.account,
      ...(p.accounts.length > 1 ? { also_in: p.accounts.filter((a) => a !== p.account) } : {}),
    }));
  return { count: properties.length, properties, ...(index.errors.length ? { errors: index.errors } : {}) };
}

async function listAccountsTool(env: Env, owner: string) {
  const [accounts, index] = await Promise.all([listAccounts(env, owner), propertyIndex(env, owner).catch(() => null)]);
  return {
    accounts: accounts.map((a) => ({
      email: a.email,
      status: a.status === 'ok' ? 'conectada' : 'sin acceso: hay que volver a añadirla',
      added: a.addedAt.slice(0, 10),
      properties: index ? index.properties.filter((p) => p.accounts.includes(a.email)).length : undefined,
      ...(a.error ? { error: a.error } : {}),
    })),
    how_to_manage:
      'Para añadir o quitar cuentas: en Claude, desconecta el conector y vuelve a conectarlo. En la página de inicio de sesión verás las cuentas y podrás añadir o quitar.',
  };
}

async function runTool(env: Env, owner: string, name: string, args: any) {
  switch (name) {
    case 'list_accounts':
      return listAccountsTool(env, owner);
    case 'list_properties':
      return listProperties(env, owner, args);
    case 'search_analytics':
      return searchAnalytics(env, owner, args);
    case 'inspect_url':
      return inspectUrl(env, owner, args);
    case 'list_sitemaps':
      return listSitemaps(env, owner, args);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleRpc(env: Env, owner: string, msg: RpcRequest): Promise<object | null> {
  const isNotification = msg.id === undefined;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Petición JSON-RPC no válida');
  }
  if (isNotification) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (!TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `Herramienta desconocida: ${name}`);
      try {
        const data = await runTool(env, owner, name, args);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false },
        };
      } catch (e) {
        const message = e instanceof GoogleError ? e.message : `Error inesperado: ${(e as Error).message}`;
        if (!(e instanceof GoogleError)) console.error(e);
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: message }], isError: true } };
      }
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id: msg.id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };
    default:
      return rpcError(msg.id, -32601, `Método no disponible: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env, owner: string): Promise<Response> {
  if (request.method === 'GET') {
    // Sin flujo SSE del servidor: este conector no envía mensajes por iniciativa propia.
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'JSON no válido'), { status: 400 });
  }
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(env, owner, m)))).filter(Boolean);
    return replies.length ? new Response(JSON.stringify(replies), { headers }) : new Response(null, { status: 202 });
  }
  const reply = await handleRpc(env, owner, body as RpcRequest);
  return reply ? new Response(JSON.stringify(reply), { headers }) : new Response(null, { status: 202 });
}
