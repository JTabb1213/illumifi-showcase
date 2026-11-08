import { describe, expect, it } from 'vitest';
import { assetNumbers } from './hlAssets';
import { checkPlan, PlanMismatch, type Intent, type Plan } from './orderCheck';

const ADDR = '0x' + 'ab'.repeat(20);
const FEE = { b: '0xaad136b674aef4ef742842e20b8617338c605f37', f: 25 };

// What the server's SDK builds for "buy $20 of BTC at 3× isolated" with BTC at 50,000 (backend test_order_plan.py)
function buyPlan(over: { order?: object; lev?: object; withFee?: boolean } = {}): Plan {
  const order = { a: 0, b: true, p: '51000', s: '0.0004', r: false, t: { limit: { tif: 'Ioc' } }, ...over.order };
  const steps = [
    { role: 'leverage', nonce: 1, action: { type: 'updateLeverage', asset: 0, isCross: false, leverage: 3, ...over.lev } },
    { role: 'main', nonce: 2, action: { type: 'order', orders: [order], grouping: 'na', ...(over.withFee ? { builder: FEE } : {}) } },
  ];
  if (over.withFee) steps.push({ role: 'nofee', nonce: 3, action: { type: 'order', orders: [order], grouping: 'na' } });
  return { kind: 'open', address: ADDR, steps };
}

const BUY: Intent = {
  kind: 'open', asset: 0, lot: 0.00001, appFee: { builder: FEE.b, fee: 25 }, isBuy: true, type: 'market', notionalUsd: 20,
  leverage: 3, isolated: true, slippage: 0.02, refPx: 50_020,
};

const bad = (plan: Plan, intent: Intent = BUY) => expect(() => checkPlan(plan, intent, ADDR)).toThrow(PlanMismatch);

describe('checking an order before this device signs it', () => {
  it('passes the order that was asked for, with or without the app fee', () => {
    expect(() => checkPlan(buyPlan(), BUY, ADDR)).not.toThrow();
    expect(() => checkPlan(buyPlan({ withFee: true }), BUY, ADDR)).not.toThrow();
  });

  it('refuses another market, side, size, price, leverage or margin type', () => {
    bad(buyPlan({ order: { a: 1 } }));                       // ETH instead of BTC
    bad(buyPlan({ order: { b: false } }));                   // a sell
    bad(buyPlan({ order: { s: '0.01' } }));                  // $500 instead of $20
    bad(buyPlan({ order: { p: '80000' } }));                 // a price far from the screen's
    bad(buyPlan({ order: { r: true } }));
    bad(buyPlan({ order: { t: { limit: { tif: 'Gtc' } } } }));
    bad(buyPlan({ lev: { leverage: 40 } }));
    bad(buyPlan({ lev: { isCross: true } }));
    bad(buyPlan({ lev: { asset: 1 } }));
  });

  it('refuses another wallet, an extra action, or a stranger in the fee', () => {
    expect(() => checkPlan(buyPlan(), BUY, '0x' + 'cd'.repeat(20))).toThrow(PlanMismatch);
    const extra = buyPlan();
    extra.steps.push({ role: 'other', nonce: 9, action: { type: 'withdraw3', destination: '0x1', amount: '5' } });
    bad(extra);
    const twice = buyPlan();
    twice.steps.push({ ...twice.steps[1], nonce: 9 });
    bad(twice);
    const fee = buyPlan({ withFee: true });
    (fee.steps[1].action as { builder: { f: number } }).builder = { ...FEE, f: 5000 };   // a 5% fee
    bad(fee);
    const more = buyPlan({ withFee: true });
    (more.steps[1].action as { builder: { f: number } }).builder = { ...FEE, f: 100 };   // over the app's own 0.025%
    bad(more);
    const other = buyPlan({ withFee: true });
    (other.steps[1].action as { builder: object }).builder = { b: '0x' + '99'.repeat(20), f: 25 };   // someone else
    bad(other);
    expect(() => checkPlan(other, { ...BUY, appFee: null } as Intent, ADDR)).not.toThrow();   // fee info not loaded
    const changed = buyPlan({ withFee: true });
    changed.steps[2].action = { type: 'order', orders: [{ a: 0, b: false, p: '1', s: '9', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' };
    bad(changed);                                           // the no-fee copy must be the same order
    const two = buyPlan();
    (two.steps[1].action as { orders: unknown[] }).orders.push({ a: 0, b: true, p: '51000', s: '1', r: false, t: { limit: { tif: 'Ioc' } } });
    bad(two);
  });

  it('lets the $10 minimum round a small order up, and a typed coin amount through as typed', () => {
    const small = { ...BUY, notionalUsd: 9 } as Intent;
    expect(() => checkPlan(buyPlan({ order: { s: '0.0002' } }), small, ADDR)).not.toThrow(); // $10.20 at 51,000
    // a $10 short with BTC at 102,140: rounded up a whole size step to clear $10 at the slipped price → $11.01
    const short = { ...BUY, isBuy: false, notionalUsd: 10, refPx: 102_140 } as Intent;
    expect(() => checkPlan(buyPlan({ order: { b: false, p: '100097', s: '0.00011' } }), short, ADDR)).not.toThrow();
    const coins = { ...BUY, size: 0.0004, notionalUsd: 1 } as Intent;
    expect(() => checkPlan(buyPlan(), coins, ADDR)).not.toThrow();
    bad(buyPlan({ order: { s: '0.0005' } }), coins);
  });

  it('a limit order rests at the price the person typed', () => {
    const intent = { ...BUY, type: 'limit', limitPx: 48_000, refPx: undefined } as Intent;
    const plan = buyPlan({ order: { p: '48000', t: { limit: { tif: 'Gtc' } } } });
    plan.kind = 'limit';
    expect(() => checkPlan(plan, intent, ADDR)).not.toThrow();
    plan.steps[1].action = { ...plan.steps[1].action, orders: [{ a: 0, b: true, p: '49000', s: '0.0004', r: false, t: { limit: { tif: 'Gtc' } } }] };
    bad(plan, intent);
  });

  it('a close is reduce-only, so it can never open or flip a position', () => {
    const intent: Intent = { kind: 'close', asset: 0, appFee: null, type: 'market', slippage: 0.02, refPx: 50_000 };
    const plan: Plan = { kind: 'close', address: ADDR, steps: [{ role: 'main', nonce: 1, action: {
      type: 'order', grouping: 'na', orders: [{ a: 0, b: false, p: '49000', s: '0.01', r: true, t: { limit: { tif: 'Ioc' } } }] } }] };
    expect(() => checkPlan(plan, intent, ADDR)).not.toThrow();
    (plan.steps[0].action as { orders: { r: boolean }[] }).orders[0].r = false;
    bad(plan, intent);
    bad({ ...plan, kind: 'open' }, intent);
  });

  it('a cancel cancels that one order, a margin change adds exactly that amount', () => {
    const cancel: Plan = { kind: 'cancel', address: ADDR, steps: [{ role: 'main', nonce: 1, action: { type: 'cancel', cancels: [{ a: 0, o: 42 }] } }] };
    expect(() => checkPlan(cancel, { kind: 'cancel', asset: 0, oid: 42 }, ADDR)).not.toThrow();
    bad(cancel, { kind: 'cancel', asset: 0, oid: 43 });
    const margin: Plan = { kind: 'margin', address: ADDR, steps: [{ role: 'main', nonce: 1, action: { type: 'updateIsolatedMargin', asset: 0, isBuy: true, ntli: 5_000_000 } }] };
    expect(() => checkPlan(margin, { kind: 'margin', asset: 0, amountUsd: 5 }, ADDR)).not.toThrow();
    bad(margin, { kind: 'margin', asset: 0, amountUsd: 0.5 });
  });
});

describe("the exchange's market numbers", () => {
  it('count from 0 on the main dex and from 110000 per builder dex, like the server’s SDK', () => {
    const main = assetNumbers([{ name: 'BTC', szDecimals: 5 }, { name: 'ETH', szDecimals: 4 }, { name: 'kPEPE', szDecimals: 0 }], '', []);
    expect([main.get('BTC'), main.get('KPEPE')]).toEqual([{ asset: 0, lot: 0.00001 }, { asset: 2, lot: 1 }]);
    const dexs = [null, { name: 'xyz' }, { name: 'abc' }];
    const xyz = assetNumbers([{ name: 'xyz:TSLA', szDecimals: 3 }, { name: 'xyz:NVDA', szDecimals: 3 }], 'xyz', dexs);
    expect(xyz.get('XYZ:NVDA')?.asset).toBe(110_001);
    const abc = assetNumbers([{ name: 'abc:X', szDecimals: 2 }], 'abc', dexs);
    expect(abc.get('ABC:X')?.asset).toBe(120_000);
    expect(() => assetNumbers([], 'nope', [null])).toThrow();
  });
});
