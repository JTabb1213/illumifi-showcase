# Illumifi: selected source

[Illumifi](https://illumifi.app) is a live web app for investing and payments. People sign in, hold wallets on several
networks, track a portfolio, send money, and trade spot, futures and prediction markets.

The full codebase is private because it runs a live service that handles real money. This repo explains how the
system works and shares a few self-contained pieces of its **client-side security code**, unchanged from
production, along with their tests.

## The system at a glance

| | |
|---|---|
| **Backend** | Python 3.12, FastAPI, SQLite (15+ databases with versioned schema migrations), Redis |
| **Frontend** | React 19, TypeScript, Vite |
| **Infrastructure** | 4 Linux servers, 21 systemd services and scheduled jobs, Caddy reverse proxy with automatic HTTPS |
| **Operations** | Test-gated automated deploys, a monitoring watchdog with phone alerts, written runbooks, one-step rollback |
| **Size** | About 150,000 lines of application code and 3,700 automated tests |

```mermaid
flowchart LR
  B["Browser<br/>React app, keys and signing"] -->|HTTPS| C["Caddy<br/>reverse proxy, TLS"]
  C --> A["FastAPI API"]
  A --> D[("SQLite databases")]
  A --> R[("Redis<br/>live prices, cache")]
  K["Data collectors<br/>systemd services and timers"] --> D
  K --> R
  X["Exchanges and<br/>blockchain networks"] --> K
  A -->|"relays orders the browser signed"| X
  W["Watchdog"] -.->|"health checks"| A
  W -.-> K
```

The rule behind the whole design: **the server never holds a key that can move a user's money.** It works out
what an order should be, the browser checks it and signs it, and the server only relays the signed result.

A second rule: **outside services are only called from background collectors, never inside a user's request.**
Collectors write to SQLite and Redis, and the API reads from there. A slow or broken outside service makes the data
a little older; it never makes a page hang.

## How it works

### Live market data

```mermaid
flowchart LR
  subgraph Sources
    EX["Exchange WebSocket<br/>best bid and offer per market"]
    EXC["Exchange candle stream"]
    BN["Market data APIs<br/>candles, stats, calendars"]
  end
  subgraph Collectors["Collectors (systemd)"]
    PC["Price collector<br/>330+ markets"]
    CC["Candle collector<br/>5-minute bars"]
    MC["Market collector<br/>stats, funding, ratings, supply"]
  end
  EX --> PC
  EXC --> CC
  BN --> CC
  BN --> MC
  PC --> RD[("Redis<br/>latest prices")]
  MC --> RD
  MC --> HD[("Market history DB")]
  CC --> CD[("Candles DB<br/>5m, then 1h, 1d, 1w derived")]
  RD --> API["API"]
  CD --> API
  HD --> API
  API -->|"WebSocket push"| BR["Every open browser"]
  API -->|"HTTPS"| BR
```

- **Prices** for 330+ markets stream over a WebSocket that pushes on every change in a market's best bid or offer. The
  collector writes them to Redis, and the API pushes them to every open browser over its own WebSocket. One
  outside connection serves every user.
- **Charts** come from 5-minute candles. Longer timeframes are built from those, so every bar is an exact
  aggregate. The collector starts from the newest stored bar, so after any downtime it fills the gap by itself.
- **Market stats** (volume, funding, earnings dates, analyst ratings, coin supply) refresh on each source's own
  schedule. If a source fails, its last good data stays up and the others keep updating.

### Balances and portfolio value

```mermaid
flowchart TB
  P["Who has the app open?<br/>presence in Redis"] --> S{"How often to refresh"}
  S -->|"app open"| H["Every 60 s"]
  S -->|"phone alerts on"| WM["Every 2 min"]
  S -->|"everyone else"| I["Every 15 min"]
  H & WM & I --> PC["Portfolio collector<br/>reads each wallet on every network"]
  RPC["Blockchain RPCs<br/>with provider failover"] --> PC
  PC --> PD[("Portfolio DB<br/>quantities, fills, transfers, value history")]

  US["User stream<br/>one WebSocket per active account"] -->|"fill, liquidation, order update"| NOW["Re-read that wallet now"]
  WH["Deposit webhooks"] -->|"coins arrived"| NOW
  ACT["The app's own send, swap or trade"] -->|"follow it until the money lands"| NOW
  NOW --> PD

  PD --> API["API"]
  RD[("Redis<br/>live prices")] --> API
  API -->|"quantity x live price, on every read"| BR["Browser"]
  API -.->|"refresh now nudge over WebSocket"| BR
```

- The collector stores **quantities**, not dollar values. The API multiplies them by live prices on every read,
  so a portfolio's value moves with the market even between refreshes.
- How often quantities refresh depends on the person. Someone with the app open gets a refresh every minute.
  Someone who isn't using it gets one every 15 minutes, which keeps outside API costs flat as accounts grow.
- Events that can't wait skip the schedule. These are a fill, a liquidation, an incoming deposit, or money the app
  itself just sent. Each one re-reads that wallet immediately and tells the browser to refresh.

### Placing an order

```mermaid
sequenceDiagram
  actor U as Person
  participant B as Browser
  participant S as API server
  participant X as Exchange
  U->>B: Buy 20 USD of BTC at 3x
  B->>S: Prepare this order
  S->>S: Work out size, price, leverage and fee. Check limits and region.
  S-->>B: Exact exchange actions, sealed with an HMAC, valid 30 s
  B->>X: Read market numbers directly
  B->>B: Check every field against what was asked. Mismatch means stop.
  B->>B: Sign with the trade-only key
  B->>S: Submit the sealed plan and signatures
  S->>S: Seal intact, still fresh, this person's wallet
  S->>S: Every signature from this wallet's registered trading key
  S->>S: Record the attempt in the money ledger
  S->>X: Relay the signed actions
  X-->>S: Filled, or resting as a limit order
  S->>S: Record the outcome in the ledger
  S-->>B: Result. Position details follow over the WebSocket.
```

- **The server can't change an order after preparing it.** The plan is sealed with an HMAC, so a tampered or
  expired plan is refused.
- **The browser won't sign something the person didn't ask for.** The check is
  [`orderCheck.ts`](src/keystore/orderCheck.ts) in this repo.
- **The server only relays signatures from the key registered to that wallet.** It never holds that key.
- **Every attempt is recorded in an add-only money ledger,** including rejected ones, along with how each one ended.

### Sign-in and keys

```mermaid
flowchart TB
  PW["Master password<br/>never leaves the browser"] --> KDF["PBKDF2-SHA256<br/>600,000 rounds, per-account salt"]
  KDF --> VK["Vault key, AES-GCM<br/>stays in the browser, can't be exported"]
  KDF --> AH["Auth hash<br/>one-way"]
  AH -->|"sent to sign in, stored only as a hash"| SRV["Server"]
  PH["12-word recovery phrase"] --> SEED["BIP-39 seed"]
  SEED --> EVM["Ethereum and EVM"]
  SEED --> BTC["Bitcoin"]
  SEED --> DOGE["Dogecoin"]
  SEED --> XMR["Monero"]
  EVM -->|"HKDF-SHA256"| TK["Trade-only key<br/>can trade, can't withdraw"]
  EVM & BTC & DOGE & XMR & TK --> ENC["Encrypted with the vault key"]
  VK --> ENC
  ENC --> DEV["Stored on the device"]
  ENC -.->|"optional backup, still encrypted"| SRV
  TK -.->|"public address only"| SRV
```

The server can't open a backup, because it never has the vault key. A leak of the server's database would show
neither passwords nor wallet keys.

### Where data lives

Each kind of data has its own SQLite database, so one busy writer never blocks another. Each schema is applied
on every connect. Changes on a feature branch may only add things; anything old is removed later in a separate
cleanup release, once nothing reads it.

```mermaid
flowchart LR
  API["API"] --> ACC[("Accounts<br/>sign-in, portfolios, wallets,<br/>encrypted backups")]
  API --> LED[("Money ledger<br/>every money action, add-only")]
  PCOL["Portfolio collector<br/>and user stream"] --> POR[("Portfolio<br/>quantities, fills, transfers,<br/>value history")]
  CCOL["Candle collector"] --> CAN[("Candles")]
  MCOL["Market collector"] --> MKT[("Market history")]
  WD["Watchdog"] --> HLT[("Health<br/>incidents, issues")]
  ALL["Every process"] --> ERR["Error journal, JSON lines<br/>plus a heartbeat per process"]
  ERR --> WD
  OPS["Owner-only ops console"] -.->|"read"| LED
  OPS -.->|"read"| HLT
```

The core account model, simplified:

```mermaid
erDiagram
  ACCOUNT ||--o{ LOGIN_METHOD : "signs in with"
  ACCOUNT ||--o{ DEVICE : "trusts"
  ACCOUNT ||--o{ SESSION : "has"
  ACCOUNT ||--o{ ENCRYPTED_BACKUP : "may keep"
  ACCOUNT ||--o{ PORTFOLIO : "owns"
  PORTFOLIO ||--o{ WALLET : "holds"
  WALLET ||--o{ MONEY_ACTION : "recorded in ledger"
  SESSION {
    text token_hash "stored only as a hash"
  }
  ENCRYPTED_BACKUP {
    blob ciphertext "server can't decrypt"
  }
  WALLET {
    text venue
    text address "public"
    text trade_key_address "public address, no private key"
  }
  MONEY_ACTION {
    text kind "order, send, swap, bank transfer"
    text outcome "how it ended"
  }
```

### From commit to production, and keeping it running

```mermaid
flowchart TB
  subgraph Deploy
    direction LR
    M["Reviewed code<br/>on main in Git"] --> G{"Clean, pushed,<br/>exactly main?"}
    G -->|"no"| STOP["Refuse"]
    G -->|"yes"| T["Run every backend<br/>and frontend test"]
    T --> BLD["Generate API types<br/>and build the frontend"]
    BLD --> SH["Copy to the server"]
    SH --> RS["Restart only the services<br/>whose code changed"]
  end
  subgraph Monitor
    direction LR
    RS --> WD["Watchdog<br/>heartbeats, error log, data freshness,<br/>disk space, TLS certificates"]
    WD -->|"problem"| INC["Open an incident<br/>with a runbook"]
    INC --> AL["Phone alert"]
    INC --> FIX["Restart, roll back or ship a fix<br/>from a fixed list of actions"]
  end
```

- A deploy **refuses** anything other than exactly what's on `main` with nothing uncommitted. There's no way to
  ship untested or local-only code.
- The frontend's API types are **generated from the backend**, so a mismatch between the two fails the build
  instead of reaching users.
- Databases are **backed up before** any change to them.
- Automatic fixes are limited to a **fixed list of safe actions**: restart a service, roll back to the previous
  release, or ship a small fix through the same tested pipeline. There's no open shell access.

## What's in this repo

All code is in [`src/keystore/`](src/keystore).

### 1. One password, two keys ([`masterKey.ts`](src/keystore/masterKey.ts), [`vault.ts`](src/keystore/vault.ts))
The master password never leaves the browser. PBKDF2 (600,000 rounds) turns it into:
- an **AES-GCM vault key** that encrypts the user's wallet keys on the device and can't be read out of JavaScript, and
- a one-way **auth hash** that proves the password to the server without revealing it or the vault key.

The browser also refuses weak settings sent by the server (too few rounds, a short salt), so a server that has
been broken into can't quietly weaken how the password is protected.

### 2. Every wallet from one recovery phrase ([`phrase.ts`](src/keystore/phrase.ts), [`utxo.ts`](src/keystore/utxo.ts), [`phraseBtc.ts`](src/keystore/phraseBtc.ts), [`phraseDoge.ts`](src/keystore/phraseDoge.ts), [`phraseXmr.ts`](src/keystore/phraseXmr.ts), [`xmrAddress.ts`](src/keystore/xmrAddress.ts))
Standard BIP-39 / BIP-32 hierarchical deterministic derivation, so the same 12 words restore the same wallets in
other wallet apps:

| Network | Path | Address |
|---|---|---|
| Ethereum and EVM chains | `m/44'/60'/0'/0/i` | hex |
| Bitcoin | `m/84'/0'/0'/0/i` | native SegWit (bech32) |
| Dogecoin | `m/44'/3'/0'/0/i` | P2PKH (base58check) |
| Monero | `m/44'/128'/i'/0/0` | Monero base58, view key from the spend key |

Monero has no standard way to derive from BIP-39, so this follows the method Cake Wallet and Exodus share. The test
values were cross-checked against Monero's own wallet code. The app also supports Solana and XRP, which aren't
included here because they need large SDKs.

### 3. The browser checks every exchange order before signing it ([`orderCheck.ts`](src/keystore/orderCheck.ts), [`hlAssets.ts`](src/keystore/hlAssets.ts))
The server builds the exact exchange actions for an order. Before signing, the browser checks each one against
what the person asked for: market (read from the exchange directly, not from the server), side, size, price,
leverage, margin type, and that the app's fee is no more than the published rate. Any difference means nothing
is signed. Even a compromised server can't get a device to sign a different trade.

### 4. A trade-only key derived from the owner key ([`hl.ts`](src/keystore/hl.ts))
Orders are signed by a separate key that can trade but can't withdraw or transfer funds. It's derived from the
owner key with HKDF-SHA256, so every device holding the owner key gets the same trading key without any key
being sent anywhere. Renewing moves to the next key number, which retires a key that may have leaked.

## Run the tests

```bash
npm install
npm test           # vitest
npm run typecheck  # strict TypeScript
```

## Notes
- **Excerpts.** Some comments mention files in the private codebase that aren't included here.
- **Test keys are dummy values.** The recovery phrase in the tests is the public BIP-39 test phrase. None of them hold funds.
- **No home-made cryptography.** Hashing, curves and key derivation come from audited libraries
  ([`@noble`](https://github.com/paulmillr/noble-hashes), [`@scure`](https://github.com/paulmillr/scure-bip32),
  [`viem`](https://viem.sh)) and the browser's built-in WebCrypto. This code combines them correctly for each network.
- Built with AI-assisted development (Claude Code).

Copyright © 2026 John Tabb. All rights reserved. Shared for review.
