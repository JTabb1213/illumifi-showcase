// phraseBtc.ts — BIP-39 secret phrase -> native Bitcoin address, using the SAME phrase as every other chain.
// BIP-84 native SegWit (bech32, "bc1…"): path m/84'/0'/0'/0/{index} (coin type 0 = Bitcoin), the modern
// default — lowest fees and broadest exchange-withdrawal support. Portfolio `index` sits at the address_index
// position, matching EVM (m/44'/60'/0'/0/{i}) and XRP (m/44'/144'/0'/0/{i}). The address is bech32 of
// (witness v0, hash160(pubkey)); the secret is WIF (mainnet version 0x80). Shared HD machinery in utxo.ts.
import { bech32 } from '@scure/base';
import { deriveKeys, hash160, toWif } from './utxo';

const WIF_VERSION = 0x80; // Bitcoin mainnet WIF prefix

export function deriveAccount(phrase: string, index: number): { address: string; secret: string } {
  const { pubkey, privkey } = deriveKeys(phrase, `m/84'/0'/0'/0/${index}`);
  const address = bech32.encode('bc', [0, ...bech32.toWords(hash160(pubkey))]); // witness v0 + 20-byte hash
  return { address, secret: toWif(privkey, WIF_VERSION) };
}
