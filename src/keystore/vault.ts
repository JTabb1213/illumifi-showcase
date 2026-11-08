// vault.ts — AES-GCM encrypt/decrypt of a secret (an owner private key) under the session VAULT KEY. The
// vault key itself is derived from your one master password in masterKey.ts and held in memory by
// session.ts; this module is just the symmetric-crypto primitive. No password and no PBKDF2 here anymore —
// one vault key (from login) protects every wallet, so a stored blob is just {v, iv, ct}, no per-item salt.

const IV_BYTES = 12; // AES-GCM standard nonce length

export type EncryptedBlob = {
  v: 2; // schema version (v1 was the old per-wallet-password format; incompatible, re-imported)
  iv: string; // base64
  ct: string; // base64 ciphertext (secret + GCM auth tag)
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

// Encrypt `secret` under `vaultKey`. Returns only the at-rest blob (safe to persist).
export async function encryptWithKey(vaultKey: CryptoKey, secret: string): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, enc.encode(secret));
  return { v: 2, iv: toB64(iv), ct: toB64(ct) };
}

// Decrypt a blob back to the secret. Throws "could not decrypt" on a wrong key or tampered/legacy blob.
export async function decryptWithKey(vaultKey: CryptoKey, blob: EncryptedBlob): Promise<string> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, vaultKey, fromB64(blob.ct));
    return dec.decode(pt);
  } catch {
    // AES-GCM auth failure == wrong vault key (wrong password) or a corrupted/old-format blob.
    throw new Error('could not decrypt this wallet key — wrong password, or it was imported under an old scheme');
  }
}
