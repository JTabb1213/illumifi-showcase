import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { keyProofMessage, MAX_KEY_NUMBER, signKeyProof, signPlanStep, tradeKeyFor, tradeKeyNumber } from './hl';

const KEY = `0x${'11'.repeat(32)}` as const;

describe('signing an order step with the trading key', () => {
  it('makes exactly the signature the server checks (backend tests/hl/test_order_plan.py)', async () => {
    // the action as it arrives from the server: JSON, keys in the SDK's order
    const action = JSON.parse(
      '{"type":"order","orders":[{"a":0,"b":true,"p":"51000","s":"0.0004","r":false,"t":{"limit":{"tif":"Ioc"}}}],' +
        '"grouping":"na","builder":{"b":"0xaad136b674aef4ef742842e20b8617338c605f37","f":25}}',
    );
    const sig = await signPlanStep(KEY, { role: 'main', action, nonce: 1_800_000_000_000 });
    expect(sig).toEqual({
      r: '0xe5b5278cdae920677b7c04adbe39d1fbc275ed31b38a14d397c54f43637a686f',
      s: '0x1b95186c38d664944f1bc517f27613fde924827af6c3a2db71dcbd1b3a0be373',
      v: 27,
    });
  });
});

describe('proving this device holds a trading key', () => {
  it('uses the server’s exact words (backend wallets.proof_message)', () => {
    expect(keyProofMessage(7, '0xABab', 123)).toBe('Illumifi: use this trading key for wallet 7 (0xabab) at 123');
  });

  it('is signed by the key itself', async () => {
    const sig = await signKeyProof(KEY, 7, '0xab', 123);
    const by = await recoverMessageAddress({ message: keyProofMessage(7, '0xab', 123), signature: sig as `0x${string}` });
    expect(by).toBe(privateKeyToAccount(KEY).address);
  });
});

describe('the trading key, worked out from the owner key', () => {
  const OWNER = `0x${'22'.repeat(32)}` as const;

  it('is always the same for the same owner key and number — every device gets it (checked against Python HKDF)', () => {
    // These values must never change: a device that worked out a different key would no longer recognise the wallet's.
    expect(tradeKeyFor(OWNER, 0)).toBe('0x256786bb70b49bb51d70652fd060c786b1d0903237e3df51d8194108ea4aabba');
    expect(tradeKeyFor(OWNER, 1)).toBe('0x72244af87f1ef3a05fecc3a0a27a6123734dddfe1a6cd45d9ef6d28c1c628629');
    expect(tradeKeyFor(OWNER.toUpperCase().replace('0X', ''), 0)).toBe(tradeKeyFor(OWNER, 0)); // however it's written
  });

  it('is a different key for each number and each wallet, and never the owner key', () => {
    const other = generatePrivateKey();
    const keys = [tradeKeyFor(OWNER, 0), tradeKeyFor(OWNER, 1), tradeKeyFor(OWNER, 2), tradeKeyFor(other, 0)];
    expect(new Set(keys).size).toBe(4);
    expect(keys).not.toContain(OWNER);
  });

  it("finds a wallet's key number from its address, and nothing for a key made at random", () => {
    const addr = (n: number) => privateKeyToAccount(tradeKeyFor(OWNER, n)).address;
    expect(tradeKeyNumber(OWNER, addr(0))).toBe(0);
    expect(tradeKeyNumber(OWNER, addr(7).toLowerCase())).toBe(7);
    expect(tradeKeyNumber(OWNER, addr(MAX_KEY_NUMBER))).toBe(MAX_KEY_NUMBER);
    expect(tradeKeyNumber(OWNER, privateKeyToAccount(generatePrivateKey()).address)).toBeNull();
    expect(tradeKeyNumber(generatePrivateKey(), addr(0))).toBeNull(); // another wallet's owner key
  });
});
