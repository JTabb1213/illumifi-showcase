import { describe, expect, test } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { deriveAccount, keysFromSpend } from './phraseXmr';
import { checkXmrAddress, encodeXmrAddress, picoToXmr, xmrBase58Decode, xmrBase58Encode, xmrToPico, XMR_PREFIX } from './xmrAddress';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Expected values were cross-checked against monero-ts (Monero's own wallet code compiled to WASM) by
// scripts/xmr-crosscheck.mjs, and index 0 matches the published Cake Wallet/Exodus result ("43SMrTtLZsyZ…").
const IDX0 = {
  address: '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756',
  spend: 'bfafd1eb0e43da200c5c11537d355e458e7c326b3bc1b19f4546573d6bac9d0f',
  view: 'b92e5bd93ac8b259bd0e08417af9d7ed45a50a1548c2907c66ed7dd3e8436500',
};
const IDX1 = {
  address: '46R1sU9Ys6ccnBx62GWPoxMZAPBWG5W2HdDQnynkvceqJYhcHp8V5oHVKcbYxhKAG42qAUFaeunX4ZhLQ85PCnyuSNSndB5',
  spend: '0166e7628aa39b3497633dd918dc256b6961ee18be321214e4a4f042fc4ea109',
};
// From monero-ts for the index-0 wallet: its first subaddress, and the same keys on stagenet.
const SUB = '88DAExP6fh2iR45U7DJcFRP5YEQbg8T4EKhhYz7J5vg1YA17kxiQZyv6AMaMyW7yDhaKYTyDN6M5v8AAAVdtMEEB8AeZUEA';
const STAGENET = '53ePwJoJDV5ZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEExDU4i';

describe('phraseXmr', () => {
  test('derives the Cake Wallet-compatible wallet at each index', () => {
    expect(deriveAccount(ABANDON, 0)).toEqual({ address: IDX0.address, secret: IDX0.spend });
    expect(deriveAccount(ABANDON, 1)).toEqual({ address: IDX1.address, secret: IDX1.spend });
  });

  test('view key and address follow from the spend key alone', () => {
    const k = keysFromSpend(IDX0.spend);
    expect(k.view).toBe(IDX0.view);
    expect(k.address).toBe(IDX0.address);
  });

  test('refuses a spend key that is not a reduced scalar', () => {
    expect(() => keysFromSpend('ff'.repeat(32))).toThrow();
    expect(() => keysFromSpend('00'.repeat(32))).toThrow();
    expect(() => keysFromSpend('abcd')).toThrow();
  });

  test('normalizes the phrase like every other chain', () => {
    expect(deriveAccount(`  ${ABANDON.toUpperCase().replace(/ /g, '   ')} `, 0).address).toBe(IDX0.address);
  });
});

describe('xmrAddress', () => {
  test('accepts primary and subaddresses', () => {
    expect(checkXmrAddress(IDX0.address)).toEqual({ ok: true, kind: 'standard' });
    expect(checkXmrAddress(` ${SUB} `)).toEqual({ ok: true, kind: 'subaddress' });
  });

  test('accepts an integrated address (primary keys + 8-byte payment id)', () => {
    const raw = xmrBase58Decode(IDX0.address);
    const body = new Uint8Array(1 + 64 + 8);
    body[0] = XMR_PREFIX.integrated;
    body.set(raw.subarray(1, 65), 1);
    body.set([1, 2, 3, 4, 5, 6, 7, 8], 65);
    const all = new Uint8Array(77);
    all.set(body);
    all.set(keccak_256(body).subarray(0, 4), 73);
    const integrated = xmrBase58Encode(all);
    expect(integrated).toHaveLength(106);
    expect(checkXmrAddress(integrated)).toEqual({ ok: true, kind: 'integrated' });
  });

  test('refuses typos, other networks and other coins', () => {
    const typo = IDX0.address.slice(0, 50) + (IDX0.address[50] === 'a' ? 'b' : 'a') + IDX0.address.slice(51);
    expect(checkXmrAddress(typo).ok).toBe(false);
    expect(checkXmrAddress(STAGENET).ok).toBe(false);
    expect(checkXmrAddress('0x52908400098527886E0F7030069857D2E4169EE7').ok).toBe(false);
    expect(checkXmrAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').ok).toBe(false);
    expect(checkXmrAddress(IDX0.address.slice(0, -1)).ok).toBe(false);
    expect(checkXmrAddress('').ok).toBe(false);
  });

  test('base58 round-trips every short-block length', () => {
    for (let n = 0; n <= 20; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(Array.from(xmrBase58Decode(xmrBase58Encode(data)))).toEqual(Array.from(data));
    }
  });

  test('encodes the address from public keys', () => {
    const k = keysFromSpend(IDX0.spend);
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
    expect(encodeXmrAddress(hex(k.publicSpend), hex(k.publicView))).toBe(IDX0.address);
  });

  test('piconero conversion is exact', () => {
    expect(xmrToPico('1')).toBe(1_000_000_000_000n);
    expect(xmrToPico('0.000000000001')).toBe(1n);
    expect(xmrToPico('.5')).toBe(500_000_000_000n);
    expect(xmrToPico('0.4210')).toBe(421_000_000_000n);
    expect(xmrToPico('0.0000000000001')).toBeNull();
    expect(xmrToPico('1e3')).toBeNull();
    expect(xmrToPico('')).toBeNull();
    expect(picoToXmr(421_000_000_000n)).toBe('0.421');
    expect(picoToXmr(1n)).toBe('0.000000000001');
    expect(picoToXmr(5_000_000_000_000n)).toBe('5');
  });
});
