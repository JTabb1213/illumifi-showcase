// phrase.ts — BIP-39/BIP-32 secret-phrase support via viem. A secret phrase (12 or 24 words) is the ROOT
// of a whole tree of wallets: index 0, 1, 2, … each derive deterministically down the standard Ethereum
// path m/44'/60'/0'/0/{index}. So one phrase can generate any number of wallets, and re-importing the same
// phrase regenerates the exact same addresses. (All EVM here — Hyperliquid/Arbitrum — so every derived
// wallet is the same network, differing only by index. Other networks would use different path segments;
// not needed until a non-EVM venue exists.) Imported single keys have NO phrase and can't be regenerated.

import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { validateMnemonic } from '@scure/bip39';
import { toHex } from 'viem';

// Normalize to the canonical BIP-39 form (lowercase, single-spaced) so storage + derivation always match. Commas and
// list numbers ("1. word", "2) word") are dropped too, since phrases are often written down that way; BIP-39 words
// never contain digits or commas, so a phrase already in canonical form comes out unchanged.
function normalize(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/\d+\s*[.)]?/g, ' ')
    .replace(/[,;]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// A fresh random 12-word secret phrase.
export function newSecretPhrase(): string {
  return generateMnemonic(english);
}

// Human-readable reason a phrase is rejected, or null if it's valid. Distinguishes a wrong WORD COUNT from a
// checksum failure (a misspelled or mis-ordered word) so the UI can tell the user what to actually fix. NOTE:
// a phrase that is valid BIP-39 but simply isn't yours cannot be caught here — it derives a real (just empty)
// wallet, so "my balances are missing" is the only signal for that case (inherent to self-custody).
export function phraseError(phrase: string): string | null {
  const norm = normalize(phrase);
  const words = norm.split(' ').filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    return `A secret phrase is 12 or 24 words — you entered ${words.length}.`;
  }
  // Real BIP-39 validation: wordlist membership + checksum. NOTE: viem's mnemonicToAccount does NOT
  // validate — it PBKDF2-hashes ANY string, so a misspelled/transposed word would silently derive a
  // WRONG (empty) wallet with no error. validateMnemonic (viem's own @scure/bip39 dep, reusing viem's
  // `english` wordlist) is what actually catches a bad word or a checksum failure.
  if (!validateMnemonic(norm, english)) {
    return 'One or more words looks misspelled or out of order — check each word against your backup.';
  }
  return null;
}

// Valid BIP-39 phrase (right word count + checksum)?
export function isValidPhrase(phrase: string): boolean {
  return phraseError(phrase) === null;
}

export { normalize as normalizePhrase };

// Derive the wallet at `index`: its public address + private key (0x-hex), ready to register + vault.
export function deriveAccount(phrase: string, index: number): { address: string; privateKey: string } {
  const account = mnemonicToAccount(normalize(phrase), { addressIndex: index });
  const hd = account.getHdKey();
  if (!hd.privateKey) throw new Error('could not derive the private key from the secret phrase');
  return { address: account.address, privateKey: toHex(hd.privateKey) };
}
