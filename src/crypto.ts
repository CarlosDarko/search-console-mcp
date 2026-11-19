// Cifrado de los tokens de Google guardados en KV (AES-GCM con una clave derivada del
// secreto del cliente OAuth: así no hace falta un secreto más).

const enc = new TextEncoder();
const dec = new TextDecoder();

let cached: { secret: string; key: CryptoKey } | null = null;

async function keyFor(secret: string): Promise<CryptoKey> {
  if (cached?.secret === secret) return cached.key;
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`search-console-mcp:v1:${secret}`));
  const key = await crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
  cached = { secret, key };
  return key;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function encrypt(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(secret), enc.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(data))}`;
}

export async function decrypt(secret: string, sealed: string): Promise<string> {
  const [iv, data] = sealed.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyFor(secret), unb64(data));
  return dec.decode(plain);
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
