// masterKey.ts — the one-password → (vault key + auth hash) derivation. This is the zero-knowledge core:
// from a single master password we derive TWO independent things, entirely in the browser —
//   • vaultKey  — an AES-GCM key that encrypts/decrypts your owner keys locally. NEVER leaves the tab.
//   • authHash  — a one-way value sent to the server to prove you know the password. The server stores only
//                 a further hash of it, so a database leak reveals neither the password nor the vault key.
// authHash is derived FROM the master bits via a second PBKDF2 pass, so it's a one-way function of them:
// the server, holding authHash, cannot run it backwards to recover the vault key. (Same construction
// Bitwarden/1Password use.) The per-account random salt + iteration count come from the server (prelogin).

const enc = new TextEncoder();

export const DEFAULT_KDF_ITERATIONS = 600_000;

// The salt and iteration count arrive from the server (prelogin, the Google ticket), so they are only as trustworthy
// as the server. A server that has been broken into could send 1 iteration: the auth hash it then receives would be
// cheap to guess passwords against, and the password unlocks the cloud backup. So the browser never derives with
// less than it uses for new accounts (every account since 2026-08-03 was made at 600k), nor with a broken salt.
const MAX_KDF_ITERATIONS = 10_000_000; // ~15 s in a browser; anything above is a bad reply, not a real account
const MIN_SALT_BYTES = 16; // newKdfSalt() makes 16

export class WeakKdfError extends Error {
  constructor() {
    super("This account's security settings look wrong, so we stopped before using your password. Sign in on a " +
      'device you have used before, or contact support.');
    this.name = 'WeakKdfError';
  }
}

// Whether server-sent KDF parameters pass the same check (for the sign-in cache: never keep a reply we'd refuse).
export function kdfLooksSound(kdfSaltB64: string, iterations: number): boolean {
  try {
    checkKdf(fromB64(kdfSaltB64 || ''), iterations);
    return true;
  } catch {
    return false;
  }
}

function checkKdf(salt: Uint8Array, iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < DEFAULT_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new WeakKdfError();
  }
  if (salt.length < MIN_SALT_BYTES) throw new WeakKdfError();
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

function toHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

// A fresh random KDF salt (base64), generated client-side at signup and stored server-side per account.
export function newKdfSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (let i = 0; i < salt.length; i++) s += String.fromCharCode(salt[i]);
  return btoa(s);
}

// Derive the local vault key and the server-bound auth hash from one password. Nothing here is persisted;
// the caller holds `vaultKey` in memory for the session and sends only `authHash` to the server.
export async function deriveVaultKeyAndAuth(
  password: string,
  kdfSaltB64: string,
  iterations: number
): Promise<{ vaultKey: CryptoKey; authHash: string }> {
  let salt: Uint8Array<ArrayBuffer>;
  try {
    salt = fromB64(kdfSaltB64 || '');
  } catch {
    throw new WeakKdfError();
  }
  checkKdf(salt, iterations); // before the password is touched

  // masterBits = PBKDF2(password, salt, iterations) — the root secret, never sent.
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    pwKey,
    256
  );

  // vaultKey: import the master bits directly as an AES-GCM key. Non-extractable — can't be read out of JS.
  const vaultKey = await crypto.subtle.importKey(
    'raw',
    masterBits,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // authHash = PBKDF2(masterBits, salt=password, 1) — a one-way step so the server can't reverse to the
  // vault key. One iteration is enough: reversing a single HMAC-SHA256 to recover masterBits is infeasible.
  const masterAsKdf = await crypto.subtle.importKey('raw', masterBits, 'PBKDF2', false, ['deriveBits']);
  const authBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(password), iterations: 1, hash: 'SHA-256' },
    masterAsKdf,
    256
  );

  return { vaultKey, authHash: toHex(authBits) };
}
