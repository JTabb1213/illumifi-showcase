// hlAssets.ts — Hyperliquid's own number for each market, read by THIS browser straight from the exchange's public info
// API (not through our server), so the order check (orderCheck.ts) never takes the server's word for which market an
// order trades. The same numbering the server's SDK uses: the main dex counts from 0; builder dex number i (its place in
// perpDexs, after the main dex's null) from 110000 + (i − 1) × 10000. Read once per dex per session.
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';

// A market's number, and its size step in coins (10^−szDecimals: sizes are rounded to it, so a $10 order can come
// out up to one step over).
export type Asset = { asset: number; lot: number };

const cache = new Map<string, Promise<Map<string, Asset>>>(); // dex -> COIN NAME (upper case) -> its asset

export function assetNumbers(
  universe: { name: string; szDecimals: number }[],
  dex: string,
  perpDexs: ({ name: string } | null)[],
): Map<string, Asset> {
  let offset = 0;
  if (dex) {
    const i = perpDexs.findIndex((d) => d?.name === dex);
    if (i < 1) throw new Error(`unknown market group ${dex}`);
    offset = 110_000 + (i - 1) * 10_000;
  }
  return new Map(universe.map((a, i) => [a.name.toUpperCase(), { asset: offset + i, lot: 1 / 10 ** a.szDecimals }]));
}

async function load(dex: string): Promise<Map<string, Asset>> {
  const info = new InfoClient({ transport: new HttpTransport() });
  const [meta, dexs] = await Promise.all([info.meta(dex ? { dex } : undefined), dex ? info.perpDexs() : []]);
  return assetNumbers(meta.universe, dex, dexs);
}

function numbers(dex: string): Promise<Map<string, Asset>> {
  let p = cache.get(dex);
  if (!p) {
    p = load(dex);
    p.catch(() => cache.delete(dex)); // a failed read is tried again next time
    cache.set(dex, p);
  }
  return p;
}

// `coin` on `dex` ('' = crypto, 'xyz' = stocks), matched without case like the server does.
export async function assetOf(dex: string, coin: string): Promise<Asset> {
  const plain = coin.includes(':') ? coin.split(':')[1] : coin;
  const a = (await numbers(dex)).get((dex ? `${dex}:${plain}` : plain).toUpperCase());
  if (a === undefined) throw new Error(`${plain.toUpperCase()} isn't available to trade right now.`);
  return a;
}

// Start reading a dex's numbers early (the ticket opening), so the first order doesn't wait for it.
export function preloadAssets(dex: string): void {
  void numbers(dex).catch(() => {});
}
