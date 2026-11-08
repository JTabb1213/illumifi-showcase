import { describe, expect, it } from 'vitest';
import { deriveAccount, isValidPhrase, normalizePhrase } from './phrase';

// The standard BIP-39 test phrase (public; never holds funds).
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('normalizePhrase', () => {
  it('leaves a normal phrase exactly as it is, so existing wallets derive the same addresses', () => {
    expect(normalizePhrase(PHRASE)).toBe(PHRASE);
    expect(deriveAccount(normalizePhrase(PHRASE), 0).address).toBe(deriveAccount(PHRASE, 0).address);
  });

  it('accepts words separated by commas', () => {
    const commas = PHRASE.split(' ').join(', ');
    expect(normalizePhrase(commas)).toBe(PHRASE);
    expect(isValidPhrase(normalizePhrase(commas))).toBe(true);
  });

  it('accepts a numbered list, the way phrases are often written down', () => {
    const numbered = PHRASE.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n');
    expect(normalizePhrase(numbered)).toBe(PHRASE);
    expect(normalizePhrase('1) Abandon 2) abandon')).toBe('abandon abandon');
  });
});
