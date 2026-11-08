// xmrAddress.ts — Monero addresses, LIGHT (no monero-ts / WASM): encode one from its two public keys, and check
// one a person typed. Monero has its own base58 — NOT Bitcoin's base58check: the bytes are cut into 8-byte blocks,
// each written as exactly 11 characters (a short last block gets a fixed shorter width), and the 4-byte checksum
// is the start of keccak-256 of everything before it. Layout: [network byte][32-byte public spend key]
// [32-byte public view key]([8-byte payment id] for an integrated address)[4-byte checksum].
import { keccak_256 } from '@noble/hashes/sha3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FULL_BLOCK = 8;
const FULL_ENCODED = 11;
// Encoded width of a last block holding n bytes (index = n).
const ENCODED_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

// Mainnet network bytes.
export const XMR_PREFIX = { standard: 18, integrated: 19, subaddress: 42 } as const;
export type XmrAddressKind = keyof typeof XMR_PREFIX;

function encodeBlock(block: Uint8Array): string {
  let n = 0n;
  for (const b of block) n = (n << 8n) | BigInt(b);
  const width = ENCODED_SIZES[block.length];
  const out = new Array<string>(width).fill(ALPHABET[0]);
  for (let i = width - 1; i >= 0 && n > 0n; i--) {
    out[i] = ALPHABET[Number(n % 58n)];
    n /= 58n;
  }
  return out.join('');
}

function decodeBlock(text: string, bytes: number): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) throw new Error('bad character');
    n = n * 58n + BigInt(d);
  }
  if (n >> BigInt(bytes * 8) !== 0n) throw new Error('block overflow');
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function xmrBase58Encode(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += FULL_BLOCK) s += encodeBlock(data.subarray(i, i + FULL_BLOCK));
  return s;
}

export function xmrBase58Decode(text: string): Uint8Array {
  const full = Math.floor(text.length / FULL_ENCODED);
  const rest = text.length % FULL_ENCODED;
  const restBytes = ENCODED_SIZES.indexOf(rest);
  if (restBytes < 0) throw new Error('bad length');
  const out = new Uint8Array(full * FULL_BLOCK + restBytes);
  for (let i = 0; i < full; i++) {
    out.set(decodeBlock(text.slice(i * FULL_ENCODED, (i + 1) * FULL_ENCODED), FULL_BLOCK), i * FULL_BLOCK);
  }
  if (rest) out.set(decodeBlock(text.slice(full * FULL_ENCODED), restBytes), full * FULL_BLOCK);
  return out;
}

// Standard (primary) address from the two 32-byte public keys.
export function encodeXmrAddress(pubSpend: Uint8Array, pubView: Uint8Array, prefix: number = XMR_PREFIX.standard): string {
  const body = new Uint8Array(1 + 32 + 32);
  body[0] = prefix; // every mainnet prefix is < 128, so its varint is the single byte
  body.set(pubSpend, 1);
  body.set(pubView, 33);
  const sum = keccak_256(body).subarray(0, 4);
  const all = new Uint8Array(body.length + 4);
  all.set(body);
  all.set(sum, body.length);
  return xmrBase58Encode(all);
}

export type XmrCheck = { ok: true; kind: XmrAddressKind } | { ok: false; error: string };

// Is `text` a mainnet Monero address? Says which kind (primary 4…, subaddress 8…, integrated 4… with a payment
// id) so the send screen can tell the person, and refuses testnet/stagenet or a typo (checksum).
export function checkXmrAddress(text: string): XmrCheck {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Enter a Monero address.' };
  let raw: Uint8Array;
  try {
    raw = xmrBase58Decode(t);
  } catch {
    return { ok: false, error: 'That isn’t a Monero address.' };
  }
  const kind = (Object.keys(XMR_PREFIX) as XmrAddressKind[]).find((k) => XMR_PREFIX[k] === raw[0]);
  const want = kind === 'integrated' ? 1 + 64 + 8 + 4 : 1 + 64 + 4;
  if (!kind || raw.length !== want) return { ok: false, error: 'That isn’t a Monero address.' };
  const body = raw.subarray(0, raw.length - 4);
  const sum = keccak_256(body).subarray(0, 4);
  if (sum.some((b, i) => b !== raw[raw.length - 4 + i])) {
    return { ok: false, error: 'This address has a typo — check it again.' };
  }
  return { ok: true, kind };
}

export function isXmrAddress(text: string): boolean {
  return checkXmrAddress(text).ok;
}

// Piconero (1e-12 XMR) <-> a decimal XMR string, exact — never through a float.
export const PICO_PER_XMR = 10n ** 12n;

export function xmrToPico(amount: string): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const frac = m[2] ?? '';
  if (frac.length > 12) return null;
  return BigInt(m[1] || '0') * PICO_PER_XMR + BigInt((frac + '0'.repeat(12)).slice(0, 12));
}

export function picoToXmr(pico: bigint): string {
  const neg = pico < 0n;
  const v = neg ? -pico : pico;
  const whole = v / PICO_PER_XMR;
  const frac = (v % PICO_PER_XMR).toString().padStart(12, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
