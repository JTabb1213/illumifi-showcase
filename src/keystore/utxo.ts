// utxo.ts — shared HD-derivation helpers for the UTXO chains (Bitcoin, Dogecoin). Both are secp256k1 (the
// SAME curve as EVM), so a BIP-32 HD node yields the pubkey directly; the two chains differ only in coin path
// and address encoding (bech32 for BTC, base58check for DOGE — see phraseBtc.ts / phraseDoge.ts). This keeps
// the machinery in one place and DEPENDENCY-LIGHT: @scure/bip32 + @noble/hashes only, no bitcoinjs-lib, no
// WASM — featherweight next to the Solana/XRP libraries (phraseSol.ts / phraseXrp.ts).
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { base58check } from '@scure/base';
import { normalizePhrase } from './phrase';

// The secp256k1 key pair for `phrase` at `path` (e.g. "m/84'/0'/0'/0/0"): 33-byte compressed pubkey + 32-byte
// private key. mnemonicToSeedSync is the (deliberately slow) BIP-39 PBKDF2 — same call phraseSol/phraseXrp make.
export function deriveKeys(phrase: string, path: string): { pubkey: Uint8Array; privkey: Uint8Array } {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizePhrase(phrase))).derive(path);
  if (!node.publicKey || !node.privateKey) throw new Error('HD derivation produced no key');
  return { pubkey: node.publicKey, privkey: node.privateKey };
}

// hash160 = RIPEMD-160(SHA-256(x)) — the "pubkey hash" both Bitcoin and Dogecoin build their addresses from.
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

// WIF (Wallet Import Format): base58check([version, priv32, 0x01]); the trailing 0x01 flags a compressed
// pubkey. Import-ready in Electrum / Dogecoin Core, and reconstructable for signing (future send path) — the
// UTXO analogue of Phase 1's SOL base58 / XRP hex secret encodings.
export function toWif(priv: Uint8Array, version: number): string {
  const payload = new Uint8Array(1 + priv.length + 1);
  payload[0] = version;
  payload.set(priv, 1);
  payload[payload.length - 1] = 0x01;
  return base58check(sha256).encode(payload);
}
