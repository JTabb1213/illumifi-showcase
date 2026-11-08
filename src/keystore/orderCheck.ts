// orderCheck.ts — before this device signs an order the server worked out (backend services/hl/order_plan.py), check
// that every action in it is the thing the person asked for: the right market (its number read from the exchange
// itself, hlAssets.ts), side, kind, size and price, the leverage they chose, nothing but the app's own fee. A server
// that's been tampered with then still can't get this device to sign some other trade. Plain functions (tested without
// the exchange): throws PlanMismatch, and nothing is signed or sent.
import type { PlanStep } from './hl';

export class PlanMismatch extends Error {
  constructor() {
    super("This order didn't match what you asked for, so nothing was sent.");
    this.name = 'PlanMismatch';
  }
}

export type Plan = { kind: string; address: string; steps: PlanStep[] };

// The app's own trading fee, as the app knows it (api/tradeFee.ts): an order may carry only this builder, at no more
// than this fee (tenths of a basis point). Unknown (the fee info didn't load): any builder, up to MAX_FEE.
export type AppFee = { builder: string; fee: number } | null;

// What the person asked for. `asset` is the exchange's own number for the market, `lot` its size step in coins;
// amounts as the ticket sent them.
export type Intent =
  | {
      kind: 'open';
      asset: number;
      lot: number;
      appFee: AppFee;
      isBuy: boolean;
      type: 'market' | 'limit';
      notionalUsd: number;
      size?: number; // coins, when typed in coins
      leverage: number;
      isolated: boolean;
      slippage: number;
      refPx?: number; // the live price on screen (market orders)
      limitPx?: number;
    }
  | { kind: 'close'; asset: number; appFee: AppFee; type: 'market' | 'limit'; slippage: number; refPx?: number; limitPx?: number }
  | { kind: 'cancel'; asset: number; oid: number }
  | { kind: 'margin'; asset: number; amountUsd: number };

const MIN_ORDER_USD = 10; // the exchange's minimum; a smaller amount is rounded up to it (hl_trade._order_qty)
const MAX_FEE = 100; // tenths of a basis point: 0.1%, the most a perp order's builder fee can be
const PRICE_ROOM = 0.03; // the screen's live price and the server's can differ a little

const KINDS: Record<Intent['kind'], string[]> = {
  open: ['open', 'limit'],
  close: ['close', 'close_limit'],
  cancel: ['cancel'],
  margin: ['margin'],
};

function fail(): never {
  throw new PlanMismatch();
}

function sameKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const have = Object.keys(o);
  return have.length === keys.length && keys.every((k) => k in o);
}

function near(a: number, b: number, room: number): boolean {
  return Number.isFinite(a) && b > 0 && Math.abs(a / b - 1) <= room;
}

type Wire = { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif?: string } } };

// The one order inside an "order" action, with the action's other fields checked. Returns it and its builder fee.
function theOrder(action: Record<string, unknown>): { o: Wire; builder: unknown } {
  if (action.type !== 'order' || action.grouping !== 'na') fail();
  if (!sameKeys(action, 'builder' in action ? ['type', 'orders', 'grouping', 'builder'] : ['type', 'orders', 'grouping'])) fail();
  const orders = action.orders;
  if (!Array.isArray(orders) || orders.length !== 1) fail();
  const o = orders[0] as Wire;
  if (!sameKeys(o as unknown as Record<string, unknown>, ['a', 'b', 'p', 's', 'r', 't'])) fail();
  return { o, builder: action.builder };
}

function checkFee(builder: unknown, app: AppFee): void {
  if (builder === undefined) return;
  const b = builder as { b?: unknown; f?: unknown };
  if (!sameKeys(b as Record<string, unknown>, ['b', 'f'])) fail();
  if (typeof b.b !== 'string' || !/^0x[0-9a-f]{40}$/.test(b.b)) fail();
  if (!Number.isInteger(b.f) || (b.f as number) < 0 || (b.f as number) > MAX_FEE) fail();
  if (app && (b.b !== app.builder.toLowerCase() || (b.f as number) > app.fee)) fail();
}

function checkOrder(o: Wire, intent: Intent & { kind: 'open' | 'close' }): void {
  const px = Number(o.p);
  const sz = Number(o.s);
  if (o.a !== intent.asset || !(px > 0) || !(sz > 0)) fail();
  const tif = o.t?.limit?.tif;
  if (!sameKeys(o.t as Record<string, unknown>, ['limit']) || tif !== (intent.type === 'market' ? 'Ioc' : 'Gtc')) fail();
  if (intent.type === 'limit') {
    if (!intent.limitPx || !near(px, intent.limitPx, 0.001)) fail(); // only the exchange's price rounding
  } else if (intent.refPx) {
    if (!near(px, intent.refPx, intent.slippage + PRICE_ROOM)) fail();
  }
  if (intent.kind === 'close') {
    if (o.r !== true) fail(); // reduce-only: it can only shrink the position, never open or flip one
    return;
  }
  if (o.r !== false || o.b !== intent.isBuy) fail();
  if (intent.size) {
    if (sz > intent.size * 1.0001 + 1e-9) fail();
  } else if (sz * px > Math.max(intent.notionalUsd, MIN_ORDER_USD) * (1 + intent.slippage) * 1.02 + intent.lot * px + 0.5) {
    fail(); // (a $10 order is rounded UP to clear the minimum, by up to one size step)
  }
}

// Throws PlanMismatch unless `plan` is exactly what `intent` asked for, for `walletAddress`.
export function checkPlan(plan: Plan, intent: Intent, walletAddress: string): void {
  if (!KINDS[intent.kind].includes(plan.kind)) fail();
  if ((plan.address || '').toLowerCase() !== walletAddress.toLowerCase()) fail();
  const roles = plan.steps.map((s) => s.role);
  const allowed = intent.kind === 'open' ? ['leverage', 'main', 'nofee'] : intent.kind === 'cancel' || intent.kind === 'margin' ? ['main'] : ['main', 'nofee'];
  if (new Set(roles).size !== roles.length || !roles.includes('main') || roles.some((r) => !allowed.includes(r))) fail();
  for (const step of plan.steps) {
    if (!Number.isSafeInteger(step.nonce) || step.nonce <= 0) fail();
    const a = step.action;
    if (step.role === 'leverage') {
      const it = intent as Intent & { kind: 'open' };
      if (!sameKeys(a, ['type', 'asset', 'isCross', 'leverage']) || a.type !== 'updateLeverage') fail();
      if (a.asset !== it.asset || a.isCross !== !it.isolated || a.leverage !== it.leverage) fail();
    } else if (intent.kind === 'cancel') {
      if (!sameKeys(a, ['type', 'cancels']) || a.type !== 'cancel') fail();
      const c = a.cancels as { a: number; o: number }[];
      if (!Array.isArray(c) || c.length !== 1 || !sameKeys(c[0], ['a', 'o'])) fail();
      if (c[0].a !== intent.asset || c[0].o !== intent.oid) fail();
    } else if (intent.kind === 'margin') {
      if (!sameKeys(a, ['type', 'asset', 'isBuy', 'ntli']) || a.type !== 'updateIsolatedMargin') fail();
      if (a.asset !== intent.asset || a.isBuy !== true || a.ntli !== Math.round(intent.amountUsd * 1e6)) fail();
    } else {
      const { o, builder } = theOrder(a);
      checkOrder(o, intent);
      if (step.role === 'nofee' && builder !== undefined) fail();
      checkFee(builder, intent.appFee);
    }
  }
  // the order without the fee must be the very same order
  const main = plan.steps.find((s) => s.role === 'main');
  const nofee = plan.steps.find((s) => s.role === 'nofee');
  if (nofee && main && JSON.stringify((main.action as { orders?: unknown }).orders) !== JSON.stringify((nofee.action as { orders?: unknown }).orders)) fail();
}
