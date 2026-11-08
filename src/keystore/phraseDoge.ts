// phraseDoge.ts — BIP-39 secret phrase -> native Dogecoin address, using the SAME phrase as every other chain.
// P2PKH base58check ("D…"): path m/44'/3'/0'/0/{index} (coin type 3 = Dogecoin). The address is
// base58check([0x1e, hash160(pubkey)]) — version 0x1e is what makes Dogecoin addresses start with 'D'; the
// secret is WIF (Dogecoin version 0x9e), import-ready in Dogecoin Core. Shared HD machinery in utxo.ts.
import { sha256 } from '@noble/hashes/sha2.js';
import { base58check } from '@scure/base';
import { deriveKeys, hash160, toWif } from './utxo';

const ADDR_VERSION = 0x1e; // Dogecoin P2PKH prefix -> addresses start with 'D'
const WIF_VERSION = 0x9e;  // Dogecoin WIF prefix

export function deriveAccount(phrase: string, index: number): { address: string; secret: string } {
  const { pubkey, privkey } = deriveKeys(phrase, `m/44'/3'/0'/0/${index}`);
  const address = base58check(sha256).encode(new Uint8Array([ADDR_VERSION, ...hash160(pubkey)]));
  return { address, secret: toWif(privkey, WIF_VERSION) };
}
