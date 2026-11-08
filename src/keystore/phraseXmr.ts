// phraseXmr.ts — BIP-39 secret phrase -> Monero wallet, using the SAME phrase as every other chain. Monero's own
// wallets use a separate 25-word seed, so there is no single BIP-39 standard; we follow the convention Cake Wallet,
// Exodus and Unstoppable share (they restore each other's wallets), so the same phrase typed into Cake Wallet
// opens this exact wallet:
//   BIP-32 secp256k1 at m/44'/128'/{index}'/0/0 (coin type 128 = Monero's SLIP-44 number) -> 32-byte key k
//   private spend key s = k read little-endian, mod l (l = the ed25519 group order; Monero's sc_reduce32)
//   private view key  v = keccak-256(s) mod l   (exactly how a 25-word Monero seed makes its view key)
//   address = network byte 18 + s·G + v·G + checksum, in Monero's base58 (xmrAddress.ts)
// (Ledger and Coinomi add one more keccak to k; Trezor uses an ed25519 path — different wallets, not ours.)
// Pure JS — no monero-ts/WASM — because recovery derives every chain at 20+ indexes.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { normalizePhrase } from './phrase';
import { encodeXmrAddress } from './xmrAddress';

// ed25519 group order.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function leToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function bigToLe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// Monero's sc_reduce32: 32 bytes as a little-endian number, mod l.
export function scReduce32(b: Uint8Array): Uint8Array {
  return bigToLe32(leToBig(b) % L);
}

function publicKey(secret: Uint8Array): Uint8Array {
  return ed25519.ExtendedPoint.BASE.multiply(leToBig(secret)).toRawBytes();
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export type XmrKeys = { spend: string; view: string; publicSpend: string; publicView: string; address: string };

// Every key of the wallet whose private spend key is `spendHex` (the view key follows from it).
export function keysFromSpend(spendHex: string): XmrKeys {
  const spend = fromHex(spendHex);
  if (spend.length !== 32 || leToBig(spend) >= L || leToBig(spend) === 0n) throw new Error('not a Monero spend key');
  const view = scReduce32(keccak_256(spend));
  const pubSpend = publicKey(spend);
  const pubView = publicKey(view);
  return {
    spend: spendHex,
    view: toHex(view),
    publicSpend: toHex(pubSpend),
    publicView: toHex(pubView),
    address: encodeXmrAddress(pubSpend, pubView),
  };
}

// Derive the Monero wallet at `index`: its primary address + private spend key (hex) — the secret vaulted, and
// what Cake Wallet / Feather accept as "restore from keys".
export function deriveAccount(phrase: string, index: number): { address: string; secret: string } {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizePhrase(phrase))).derive(`m/44'/128'/${index}'/0/0`);
  if (!node.privateKey) throw new Error('HD derivation produced no key');
  const keys = keysFromSpend(toHex(scReduce32(node.privateKey)));
  return { address: keys.address, secret: keys.spend };
}
