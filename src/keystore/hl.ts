// hl.ts — the SIGNING layer: turns an in-memory owner key into signed Hyperliquid actions, entirely inside
// the browser. The owner key never leaves the tab; only the signed action reaches Hyperliquid's API. viem
// derives addresses and generates the agent keypair; @nktkas/hyperliquid builds + signs the action with
// HL's exact scheme, so we never hand-roll the msgpack/EIP-712 signing.

import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { signL1Action } from '@nktkas/hyperliquid/signing';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Keys approved before 2026-11 are named "dashboard"; a wallet connected to a strategy then shares that very key with
// the bots (their own copy, backend strategy_link). Keys the app approves now go under their own name, so renewing one
// on a device never replaces the bots' key (approving a name replaces only the key under that same name).
const AGENT_NAME = 'illumifi';
export const AGENT_DAYS = 180; // Hyperliquid's longest; without a date in the name a key lasts its default 90 days

// The name the app approves its trading key under, with its end date: "illumifi valid_until <ms>" (Hyperliquid reads
// the date from the name). An hour under the full 180 days so clock differences never push it over the limit. The
// same name every time, so a renewal replaces the old key rather than adding another.
export function agentNameFor(nowMs: number): string {
  return `${AGENT_NAME} valid_until ${Math.floor(nowMs + AGENT_DAYS * 86_400_000 - 3_600_000)}`;
}

// Normalize a pasted key to the 0x-prefixed hex viem expects.
export function normKey(pk: string): `0x${string}` {
  const t = pk.trim();
  return (t.startsWith('0x') ? t : `0x${t}`).toLowerCase() as `0x${string}`;
}

// Normalize an address to the 0x-prefixed form the HL SDK's Address type wants.
function normAddr(addr: string): `0x${string}` {
  const t = addr.trim();
  return (t.startsWith('0x') ? t : `0x${t}`) as `0x${string}`;
}

// A USD amount as HL wants it: a plain decimal string (1 = $1), ≤6 dp, no trailing zeros or exponent.
function fmtUsd(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, '');
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function exchangeFor(ownerKey: string): ExchangeClient {
  const wallet = privateKeyToAccount(normKey(ownerKey));
  return new ExchangeClient({ wallet, transport: new HttpTransport() });
}

// The EVM address a private key controls — used to prove a pasted key matches the wallet before storing it.
export function addressForKey(privateKey: string): string {
  return privateKeyToAccount(normKey(privateKey)).address;
}

// ---- the wallet's trading key is WORKED OUT from its owner key, not made at random ------------------------------
// Key number n of a wallet = HKDF-SHA256(owner key, "illumifi trading key", "<wallet address>:<n>"). Every device that
// holds the wallet's owner key (its secret phrase, or the pasted key) works out the same keys, so a second device can
// trade at once with no approval and no backup — and two devices never replace each other's key. A renewal moves to
// the next number, so a key that leaked is retired by renewing. One-way: a trading key never gives the owner key away,
// and the owner key already controls everything. Keys made before 2026-11-06 were random; they work until renewed.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const MAX_KEY_NUMBER = 64; // ~26 years of 150-day renewals; past it a device just doesn't recognise the key

export function tradeKeyFor(ownerKey: string, n: number): `0x${string}` {
  const owner = hexToBytes(normKey(ownerKey));
  const wallet = privateKeyToAccount(normKey(ownerKey)).address.toLowerCase();
  for (let attempt = 0; ; attempt++) {
    const info = stringToBytes(`${wallet}:${n}${attempt ? `:${attempt}` : ''}`);
    const k = hkdf(sha256, owner, stringToBytes('illumifi trading key'), info, 32);
    const v = BigInt(bytesToHex(k));
    if (v > 0n && v < SECP256K1_N) return bytesToHex(k); // (any other value: practically never — try the next)
  }
}

// Which key number `agentAddress` is for this owner key, or null (a key made at random, or someone else's).
export function tradeKeyNumber(ownerKey: string, agentAddress: string): number | null {
  const want = agentAddress.toLowerCase();
  for (let n = 0; n <= MAX_KEY_NUMBER; n++) {
    if (privateKeyToAccount(tradeKeyFor(ownerKey, n)).address.toLowerCase() === want) return n;
  }
  return null;
}

// The number the next approval uses: one past the highest of this wallet's keys in use — the one the app has
// (`current`) and any Hyperliquid still lists — so a new key is never one approved before.
async function nextKeyNumber(ownerKey: string, current: string | null | undefined): Promise<number> {
  const user = privateKeyToAccount(normKey(ownerKey)).address;
  let listed: string[] = [];
  try {
    listed = (await new InfoClient({ transport: new HttpTransport() }).extraAgents({ user })).map((a) => a.address);
  } catch {
    /* can't read the list right now: go by the current key alone */
  }
  const used = [current, ...listed].filter((a): a is string => !!a).map((a) => tradeKeyNumber(ownerKey, a));
  return Math.max(-1, ...used.filter((n): n is number => n !== null)) + 1;
}

// Approve the wallet's next trading key on Hyperliquid, signed IN THE BROWSER by `ownerKey` (`current`: the key the
// app has for the wallet now, if any). Returns the key's PRIVATE half so the caller can keep it in this device's vault
// (api/tradeKeys.ts) — it can trade but never withdraw or transfer.
export async function approveAgentInBrowser(
  ownerKey: string,
  current?: string | null
): Promise<{ agentKey: string; agentAddress: string }> {
  const agentKey = tradeKeyFor(ownerKey, await nextKeyNumber(ownerKey, current));
  const agentAddress = privateKeyToAccount(agentKey).address;
  try {
    // Re-approving the same agent name simply rotates it — it won't disturb a bot's differently-named agent.
    await exchangeFor(ownerKey).approveAgent({ agentAddress, agentName: agentNameFor(Date.now()) });
  } catch (e) {
    throw new Error(`Hyperliquid rejected the agent approval: ${reason(e)}`);
  }
  return { agentKey, agentAddress };
}

// ---- the wallet's TRADING key (trade-only agent) signs every order here, never on the server ----------------------
// The server works an order out and hands over the exact Hyperliquid actions (backend services/hl/order_plan.py); the
// app checks them against what the person asked for (orderCheck.ts) and signs each one here with the trading key it
// keeps in its vault (session.ts saveTradeKey). Signed exactly as given: the action's key order is part of the hash.
export type PlanStep = { role: string; action: Record<string, unknown>; nonce: number };
export type StepSignature = { r: string; s: string; v: number };

export function signPlanStep(agentKey: string, step: PlanStep): Promise<StepSignature> {
  return signL1Action({ wallet: privateKeyToAccount(normKey(agentKey)), action: step.action, nonce: step.nonce });
}

// What a device signs with a trading key so the server will record the key's address (backend
// wallets.proof_message — the same words): only the address goes up, and anyone can read a wallet's approved keys.
export function keyProofMessage(walletId: number, address: string, atMs: number): string {
  return `Illumifi: use this trading key for wallet ${walletId} (${address.toLowerCase()}) at ${atMs}`;
}

export function signKeyProof(agentKey: string, walletId: number, address: string, atMs: number): Promise<string> {
  return privateKeyToAccount(normKey(agentKey)).signMessage({ message: keyProofMessage(walletId, address, atMs) });
}

// Put this account into UNIFIED-ACCOUNT mode: one USDC balance then collateralizes crypto (main dex), stock
// perps (xyz / HIP-3 builder dexes) AND spot at once — the one-time setup that lets the stored trade-only
// agent trade ANY market without shuttling collateral between dexes (fixes.md #6). Owner-signed in the
// browser and posted straight to HL, exactly like the agent approval above (the agent key can't do this —
// mode changes are owner-scoped; verified against mainnet). Idempotent: re-running on an already-unified
// account is a harmless no-op. `user` is derived from the owner key so it always matches the signer.
export async function setUnifiedAccountInBrowser(ownerKey: string): Promise<void> {
  const user = addressForKey(ownerKey).toLowerCase() as `0x${string}`;
  try {
    await exchangeFor(ownerKey).userSetAbstraction({ user, abstraction: 'unifiedAccount' });
  } catch (e) {
    throw new Error(`Hyperliquid rejected the account-mode change: ${reason(e)}`);
  }
}

// Approve the app's trading fee ("builder fee") for this account: lets orders the app places add up to
// `maxFeeRate` (e.g. "0.025%") for `builder`. Owner-signed in the browser and posted straight to HL, like the agent
// approval (the agent key can't do it). It can only let that fee be charged on trades — it moves no money.
export async function approveBuilderFeeInBrowser(ownerKey: string, builder: string, maxFeeRate: string): Promise<void> {
  try {
    await exchangeFor(ownerKey).approveBuilderFee({ builder: normAddr(builder), maxFeeRate: maxFeeRate as `${string}%` });
  } catch (e) {
    throw new Error(`Hyperliquid rejected the fee approval: ${reason(e)}`);
  }
}

// A transport that CAPTURES the signed exchange payload instead of sending it. The SDK still builds and
// signs the action exactly as it would for a direct POST (identical bytes) — we just intercept the finished
// {action, signature, nonce} body so OUR server can relay it, giving every money movement one audited
// origin. usdSend/withdraw3 make no other calls, so only 'exchange' is expected; anything else is a bug.
class CaptureTransport {
  isTestnet = false;
  captured: unknown = null;
  request<T>(endpoint: 'info' | 'exchange' | 'explorer', _payload: unknown): Promise<T> {
    if (endpoint !== 'exchange') return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
    this.captured = _payload;
    // Return a benign success so the SDK's response-validation doesn't throw; we read `captured` regardless.
    return Promise.resolve({ status: 'ok', response: { type: 'default' } } as T);
  }
}

// Sign an exchange action IN THE BROWSER and return the {action, signature, nonce} body — NOT posted. The
// owner key never leaves the tab; the caller hands this payload to our server (/hl/relay) to forward to HL.
async function signExchangeAction(
  ownerKey: string,
  call: (c: ExchangeClient) => Promise<unknown>
): Promise<unknown> {
  const cap = new CaptureTransport();
  const wallet = privateKeyToAccount(normKey(ownerKey));
  const client = new ExchangeClient({ wallet, transport: cap });
  try {
    await call(client);
  } catch (e) {
    // A throw BEFORE we captured means signing itself failed (bad key, validation); surface it.
    if (cap.captured == null) throw new Error(`could not sign the action: ${reason(e)}`);
  }
  if (cap.captured == null) throw new Error('could not sign the action: no payload produced');
  return cap.captured;
}

// Fund: move USDC between two HL accounts (usd_transfer / usdSend). Free + instant when the sender holds the
// balance on HL. Signs in the browser and returns the payload for the server to relay. Topping a treasury up
// from Arbitrum (the bridge) is a separate flow (deposit.ts).
export function signUsdSend(ownerKey: string, destination: string, amountUsd: number): Promise<unknown> {
  return signExchangeAction(ownerKey, (c) =>
    c.usdSend({ destination: normAddr(destination), amount: fmtUsd(amountUsd) })
  );
}

// Claim: move the account's accrued rewards (for the app's fee wallet: the builder fees it earned) into its own
// balance (claimRewards). Moves nothing to anyone else. Used by the operator console; signs and returns the payload.
export function signClaimRewards(ownerKey: string): Promise<unknown> {
  return signExchangeAction(ownerKey, (c) => c.claimRewards());
}

// Vault: put Perps USDC into a trading vault, or take it out (vaultTransfer). `usdMicro` is whole micro-dollars
// ($10 → 10_000_000, strategies/strategyMath.toMicroUsd). An L1 action: the server recovers the signer and relays
// it only for one of your own wallets and a vault the app lists (backend services/vaults.relay_check).
export function signVaultTransfer(ownerKey: string, vault: string, isDeposit: boolean, usdMicro: number):
  Promise<unknown> {
  return signExchangeAction(ownerKey, (c) =>
    c.vaultTransfer({ vaultAddress: normAddr(vault), isDeposit, usd: usdMicro })
  );
}

// Withdraw: move USDC OFF HL back to an Arbitrum address (withdraw3). HL charges a flat $1 fee (destination
// gets amount − $1). Signs in the browser and returns the payload for the server to relay.
export function signWithdraw(ownerKey: string, destination: string, amountUsd: number): Promise<unknown> {
  return signExchangeAction(ownerKey, (c) =>
    c.withdraw3({ destination: normAddr(destination), amount: fmtUsd(amountUsd) })
  );
}
