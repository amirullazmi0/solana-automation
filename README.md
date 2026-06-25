# Solana Trend Follower Bot (MaSoul Sniper)

Bot trading otomatis untuk **Solana** yang fokus pada strategi **Hybrid Momentum**: token muda diroute sebagai `MICIN_ROUTE`, token lebih matang diroute sebagai `WHALE_ROUTE`. Bot memakai filter kuantitatif, social/narrative scoring, AI conviction, dan risk breaker sebelum live buy.

**Target lama tetap sama: $5/hari dari modal $20.**

---

## Core Features

### 1. Smart Retry Watchlist (Database-Backed)
Bot tidak melupakan koin potensial. Koin yang gagal filter sementara, seperti terlalu muda, MCap kecil, atau volume belum cukup, disimpan di database **Watchlist** dan dipantau terus oleh background radar. Begitu kondisinya matang, token bisa masuk lagi ke jalur analisis.

Catatan update:
- Watchlist masih dipakai untuk retry dan discovery state.
- Jalur price monitor sekarang tidak lagi membaca `volScore` dan `priceChange1h` dari Watchlist.
- Sinyal volatilitas untuk risk adjuster sekarang diambil dari snapshot market fresh di memori.

### 2. Hybrid Quant Routing
Bot tidak lagi memakai `BOT_MODE`. Semua token masuk ke satu pipeline, lalu route ditentukan dari umur token:

- `MICIN_ROUTE` - token < 2 jam, fokus velocity, z-score, volume surge, dan anti-noise fake pump
- `WHALE_ROUTE` - token >= 2 jam, fokus momentum yang sudah tervalidasi, social footprint, CTO, narrative, dan whale signal score

Rumus matematis utama:

- **VoL (Velocity of Liquidity)** - Kecepatan aliran uang dibanding ketersediaan liquidity di pool
- **Volume Z-Score** - Deteksi anomali volume untuk menemukan jejak akumulasi whale/insider
- **Safety Index** - Analisa konsentrasi Top 10 holders, reject jika Top 10 pegang lebih dari 20% supply

Rumus yang dipakai saat ini:

```text
volScore = (volume_5m / liquidity) x confidenceScore
confidenceScore = buys_5m / (buys_5m + sells_5m)

volumeSurge = volume_5m / avgVolume_5m
avgVolume_5m = volume_1h / 12

zScore = (volume_5m - avgVolume_5m) / (avgVolume_5m x 0.5)
```

### 3. PumpFun Tolerance
Bot memahami mekanisme PumpFun:

- Freeze Authority PumpFun tokens yang baru migrate ditoleransi sementara
- LP locked diterima selain burned
- Safety RPC retry dengan backoff jika RPC error

### 4. Premium Telegram Alerts
Real-time Telegram notifications with detailed stats:

- BUY ALERT - link DexScreener dan socials, total SOL spent, harga SOL, dan estimasi USD
- TRAILING UPDATE - cooldown 5 menit agar tidak spam
- SELL ALERT - menampilkan keuntungan riil, SOL spent vs received, profit %, dan nominal USD
- WATCHLIST - notifikasi koin potensial

Tambahan update:
- Deposit SOL dari Helius webhook sekarang bisa memicu notifikasi saldo masuk.
- Auto-buy / auto-sell report ke Telegram sudah ada.

### 5. Hardened Security and Capital Protection

- Pre-Buy SOL Check - deteksi saldo SOL lokal sebelum buy untuk menyisakan `RESERVE_AMOUNT`
- Preflight Simulation - `skipPreflight: false` agar transaksi gagal bisa disimulasikan dulu
- Hard Crash Bypass - jual instan di -55% jika koin crash cepat
- DNS Hardening - fallback DoH via Cloudflare dan Google
- IPv4 Force - `https.Agent({ family: 4 })` untuk stabilitas VPS
- LP Safety Check - wajib LP burned/locked
- Mint Authority Check - wajib mint authority disabled
- Anti-Repeat Buy - cooldown dinamis 6 jam jika profit, 24 jam jika rugi
- Anti-Honeypot - deteksi koin yang tidak bisa dijual

### 6. Established Rebound and CTO Bot

Layanan kuantitatif khusus (`EstablishedAnalyzerService`) untuk mendeteksi anomali dead cat bounce atau community take over (CTO):

- Target koin mapan: umur 1-3 hari (24-72 jam) dengan likuiditas >= $3,000
- Deep sell-off: koreksi mendalam dalam 24 jam (`<= -50%`)
- Volume-price divergence: `V_5m > V_1h x 0.25` dengan pergerakan harga 5m stabil
- Buyer dominance: rasio beli vs jual > 1.5x dengan minimal 5 transaksi beli
- Strict custom exit: TP 18%, TSL 2.5%, hard SL 20%

---

## Architecture

```text
ScannerService (Discovery)
  -> EstablishedAnalyzerService (Rebound and CTO detector)
  -> AnalyzerService (Hybrid quant gate + route classification + deterministic score)
  -> AIService (Conviction judge)
  -> TradeService (Jupiter swap)
  -> PriceMonitorService (TP/SL/Trail + custom exit)
  -> ReportingService (Telegram alert)
  -> Prisma (PostgreSQL)
```

Tambahan alur discovery:

- PumpPortal websocket
- DexScreener polling
- Helius enhanced webhook `POST /helius/webhook`

---

## Configuration

Konfigurasi dipisah jadi dua:

- `.env` hanya untuk runtime dan credential: RPC, WSS, webhook secret, API key, Telegram, wallet encryption, database, OpenAI.
- `config.json` untuk angka strategi dan perhitungan: threshold filter, sizing, TP/SL, scanner interval, risk breaker, AI threshold, dan `MARKET_REGIME`.

Parameter utama di `config.json`:

| Parameter | Value | Keterangan |
|-----------|-------|------------|
| `MARKET_REGIME` | `balanced` | Bias AI untuk kondisi market. Opsi yang dipakai prompt: `balanced`, `bullish_gas`, `bearish_chaos` |
| `ANALYZER_MIN_Z_SCORE` | `1.5` | Volume anomaly detection |
| `ANALYZER_MIN_VOL_SCORE` | `0.02` | Kecepatan uang masuk pool |
| `ANALYZER_MIN_VOLUME_SURGE` | `1.5` | Volume saat ini vs rata-rata |
| `MIN_BUY_CONFIDENCE` | `0.60` | Rasio buyer vs seller |
| `MIN_LIQUIDITY_USD` | `5000` | Minimum liquidity di pool |
| `MIN_VOLUME_USD` | `200` | Minimum volume 5 menit |
| `MIN_BUY_COUNT` | `3` | Minimum buyer dalam 5 menit |
| `MIN_MCAP` | `5000` | Minimum market cap |
| `MAX_MCAP` | `3000000` | Maximum market cap |
| `MIN_AGE_HOURS` | `0.02` | Umur minimum token |
| `MAX_AGE_HOURS` | `72` | Umur maksimum token |
| `TAKE_PROFIT_PERCENT` | `15` | TP standar |
| `STOP_LOSS_PERCENT` | `12` | SL standar |
| `TRAILING_DISTANCE_PERCENT` | `1.5` | TSL standar |
| `DISABLE_SL_PATIENCE` | `true` | Patience protocol dimatikan untuk stop loss lebih cepat |

### AI Analysis Layer

| Parameter | Keterangan |
|-----------|------------|
| `OPENAI_API_KEY` | Disimpan di `.env`. Jika valid, `AnalyzerService` menjalankan `AIService.analyzeToken()` setelah filter market/RPC/RugCheck lulus |
| `AI_BASE_URL` | Disimpan di `config.json` karena bukan secret |
| `AI_MODEL` | Disimpan di `config.json` |
| `AI_CONVICTION_THRESHOLD` | Minimum skor AI agar token boleh lanjut buy |
| `WHALE_SIGNAL_SCORE_FLOOR` | Floor deterministic score untuk `WHALE_ROUTE` saat social Twitter/Telegram kosong |

### Established Rebound and CTO Thresholds

| Parameter | Value | Keterangan |
|-----------|-------|------------|
| `ESTABLISHED_MIN_AGE_HOURS` | `24` | Umur minimum token |
| `ESTABLISHED_MAX_AGE_HOURS` | `72` | Umur maksimum token |
| `ESTABLISHED_MIN_BUYS` | `5` | Minimum buyer dalam 5 menit |
| `MIN_ESTABLISHED_LIQUIDITY` | `3000` | Minimum liquidity |
| `MAX_ESTABLISHED_MCAP` | `200000` | Maksimum market cap |
| `REBOUND_PRICE_DROP_PCT` | `-50` | Penurunan harga 24 jam |
| `VOLUME_SPIKE_RATIO` | `0.25` | Lonjakan volume 5m vs 1h |
| `BUY_SELL_RATIO_THRESHOLD` | `1.5` | Dominasi buyer vs seller |

### Runtime and Connectivity

Nilai berikut tetap di `.env`:

- `PORT` - port aplikasi
- `APP_MODE` - `development` atau `production`
- `SOLANA_RPC_URL`, `RPC_ENDPOINT`, `WSS_ENDPOINT` - endpoint Solana/Helius
- `HELIUS_WEBHOOK_SECRET` - Bearer secret untuk webhook
- `JUPITER_API_KEY` - API key Jupiter
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_IDS` - Telegram runtime
- `API_SECRET_KEY` - proteksi endpoint manual buy
- `WALLET_ENCRYPTION_KEY` - enkripsi wallet vault
- `DATABASE_URL`, `DB_FAIL_FAST` - koneksi PostgreSQL
- `OPENAI_API_KEY` - credential AI

---

## Tech Stack

- Node.js with NestJS
- TypeScript
- PostgreSQL with Prisma ORM
- Solana Web3.js
- Jupiter Aggregator
- DexScreener
- RugCheck
- PumpPortal
- Helius Webhooks
- CapRover

---

## Quick Start

```bash
# 1. Install dependencies
yarn install

# 2. Setup database
npx prisma db push

# 3. Development
yarn start:dev

# 4. Production
yarn build
yarn start:prod
```

---

## Algorithm and Filter Pipeline

### Overview

Setiap token yang ditemukan oleh Scanner masuk ke pipeline hybrid. Filter kuantitatif berlaku untuk semua token, lalu route ditentukan dari umur token. Jika gagal di satu gate, token di-reject atau disimpan di Watchlist untuk retry jika bersifat temporary.

```text
Discovery
  -> Quant Gate
  -> Route Assignment: MICIN_ROUTE (< 2h) atau WHALE_ROUTE (>= 2h)
  -> Whale Signal Score
  -> AI Conviction Judge
  -> Trade Execution
```

### Discovery Layer (ScannerService)

Bot menemukan token dari beberapa sumber:

| Sumber | Metode | Kecepatan |
|--------|--------|-----------|
| PumpPortal WS | WebSocket real-time | ~instant |
| DexScreener Boosts | Polling API | 3 detik |
| DexScreener Profiles | Polling API | 3 detik |
| Helius Enhanced Webhook | HTTP POST | real-time |

Token yang ditemukan masuk ke `processNewToken()` dan di-upsert ke Watchlist sebagai `PENDING`.

### Analyzer Layer - Hybrid Gate Filter

#### Gate 1: Liquidity Check

```text
PASS jika: liquidity >= MIN_LIQUIDITY_USD ($5,000)
FAIL: zero_liquidity
```

#### Gate 2: Market Cap Range

```text
PASS jika: MIN_MCAP ($5,000) <= MCap <= MAX_MCAP ($3,000,000)
FAIL: mcap_too_low | mcap_too_high
```

#### Gate 3: Token Age

```text
PASS jika: MIN_AGE_HOURS (~1 menit) <= age <= MAX_AGE_HOURS (72h)
FAIL: too_young | too_old
```

#### Route Assignment

```text
MICIN_ROUTE jika: age < 2 jam
WHALE_ROUTE jika: age >= 2 jam
```

#### Gate 4: Volume Surge

```text
volumeSurge = volume_5m / avgVolume_5m
avgVolume_5m = volume_1h / 12

PASS jika: volumeSurge >= ANALYZER_MIN_VOLUME_SURGE (1.5x)
FAIL: low_surge
```

#### Gate 5: Price Trend

```text
PASS jika: priceChange_1h > -15%
FAIL: bearish_trend
```

#### Gate 6: Buy Confidence Score

```text
confidenceScore = buys_5m / (buys_5m + sells_5m)

PASS jika: confidenceScore >= MIN_BUY_CONFIDENCE (0.60)
FAIL: low_buy_confidence
```

#### Gate 7: Base Metrics Combo

```text
PASS jika:
  - liquidity >= MIN_LIQUIDITY_USD ($5,000)
  - volume_5m >= MIN_VOLUME_USD ($200)
  - buys_5m >= MIN_BUY_COUNT (3)
FAIL: low_metrics
```

#### Gate 8: Velocity

```text
velocity = volume_5m / marketCap

PASS jika: velocity >= MIN_VOLUME_MCAP_RATIO (0.05)
FAIL: low_velocity
```

#### Gate 9: VoL Score

```text
VoL = (volume_5m / liquidity) x confidenceScore

PASS jika: VoL >= ANALYZER_MIN_VOL_SCORE (0.02)
FAIL: low_vol_score
```

#### Gate 10: Z-Score

```text
avgVol_5m = volume_1h / 12
Z = (volume_5m - avgVol_5m) / (avgVol_5m x 0.5)

PASS jika: Z >= ANALYZER_MIN_Z_SCORE (1.5)
FAIL: no_volume_anomaly
```

#### Hybrid Social and Narrative Gate

```text
whaleSignalScore dihitung dari:
  + social footprint Twitter/Telegram/Website
  + CTO signal
  + tokenName narrative match
  + volume surge / VoL / z-score / safety index
  - empty socials
  - creator risk / rugged token history

Untuk WHALE_ROUTE:
  - Twitter dan Telegram kosong + score di bawah WHALE_SIGNAL_SCORE_FLOOR => reject

Untuk MICIN_ROUTE:
  - whaleSignalScore hanya menjadi bias ringan
  - fake pump/noise gate tetap aktif
```

#### Gate 11: Safety RPC

```text
mintInfo = getMint(connection, tokenMint)

PASS jika:
  - mintInfo.mintAuthority === null
  - mintInfo.freezeAuthority === null
  - atau token PumpFun dengan freeze authority sementara yang ditoleransi

FAIL: safety_rpc_failed
```

#### Gate 12: RugCheck API

```text
Sub-checks:
  1. Top 10 holder <= 20% supply
  2. LP status burned atau locked
  3. Risk score <= 1000
  4. Tidak ada honeypot / freeze / mint authority risk
  5. Danger risks = 0
  6. Creator balance <= 5% dari total supply
```

---

## Price Monitor Rules

PriceMonitorService mulai tracking open trades:

- Take Profit standar 15% / CTO 18% -> partial take profit lalu trailing stop aktif
- Zero-Loss Protection -> saat profit >= 15%, trailing stop minimal naik ke `entryPrice + 2%`
- Stop Loss standar 12% / CTO 20% -> Patience Protocol 5 menit jika aktif, hard cap 10 menit
- Hard crash -55% -> `PANIC_SELL` instan dengan slippage 15%
- Trailing Stop standar 1.5% / CTO 2.5% -> sell jika harga turun dari peak ke trailing stop

#### Patience Protocol update

- Jika `DISABLE_SL_PATIENCE=true`, stop loss langsung eksekusi
- Jika trade masih baru dan umur trade < 30 menit, bot bypass patience protocol
- Jika token sudah stabil dan patience aktif, timer `slTriggeredAt` + check buy pressure tetap dipakai

#### Dynamic Risk Adjuster

Trailing stop sekarang dihitung dinamis dari sinyal fresh market:

```text
effectiveTrailingDistancePercent = min(baseTrailingDistancePercent, aiRecommendedTrailingDistance)
```

AI recommendation:

- market normal -> default `TRAILING_DISTANCE_PERCENT`
- market chaos -> 3.0%
- chaos ekstrem -> 2.5%

#### Fresh Market Volatility

Loop price monitor sekarang mengambil snapshot market fresh dari DexScreener di memori untuk:

- `priceUsd`
- `volScore`
- `priceChange1h`
- `volumeSurge`
- `zScore`
- `liquidityUsd`
- `marketCapUsd`

Tidak ada lagi pembacaan `volScore` / `priceChange1h` dari Watchlist di loop evaluasi harga.

| Kondisi | Aksi | Slippage |
|---------|------|----------|
| Price naik >= `TAKE_PROFIT_PERCENT` | Partial take profit 50%, sisanya trailing | Normal |
| Profit >= 15% | SL/TSL floor dinaikkan ke `entryPrice * 1.02` | Tidak sell langsung |
| Price turun ke trailing stop | SELL (`TRAILING_STOP`) | Panic 15% |
| Price turun ke stop loss normal | Patience Protocol 5 menit, hard cap 10 menit | Panic 15% saat exit |
| Price turun >= 55% dari entry | SELL INSTAN (`PANIC_SELL`) | Panic 15% |
| Dev dump terdeteksi | SELL (`DEV_DUMP`) | Panic 15% |

Set `DISABLE_SL_PATIENCE=true` hanya jika ingin kembali ke stop loss instan.

---

## Watchlist Retry Mechanism

Token yang gagal karena alasan temporary tidak langsung dibuang:

| Fail Reason | Retry? | Keterangan |
|-------------|--------|------------|
| `too_young` | Ya | Tunggu sampai cukup umur |
| `mcap_too_low` | Ya | Tunggu MCap naik |
| `low_surge` | Ya | Tunggu volume surge |
| `safety_rpc_failed` | Ya | Retry 3x, lalu watchlist |
| `bearish_trend` | Tidak | Permanent - downtrend tajam |
| `low_buy_confidence` | Ya | Tunggu lebih banyak buyer |
| `too_old` | Ya | Temporary jika umur masih masuk established range |
| `mcap_too_high` | Tidak | Permanent - sudah terlalu besar |
| `honeypot` | Tidak | Permanent - scam |

Background radar re-check token pending berjalan berkala. Watchlist auto-cleanup tetap membersihkan token yang terlalu lama gagal.

---

## Telegram Features

### Wallet and Access Model

- Setiap Telegram chat mendapat wallet Solana sendiri
- Wallet dibuat otomatis
- Secret disimpan terenkripsi di database
- `PRIVATE_KEY` tidak dipakai lagi di flow runtime
- `APP_MODE=development` membatasi akses ke `TELEGRAM_CHAT_IDS`
- `APP_MODE=production` membuka bot untuk semua chat

### Chat Settings

- `totalSlots`
- `positionSizeUsd`
- `slippageOnSol`
- `dryRun`

### Telegram UX

- `/start` membuat atau memuat wallet untuk chat itu
- Menu utama:
  - Balance
  - Portfolio
  - Settings
  - Win Rate
  - Watchlist
- Portfolio cards:
  - Buy
  - Sell
  - Pump.fun
  - DexScreener
- Paste mint address di chat menampilkan detail token dan action button yang sama

### Dry Run Behavior

- `dryRun` disimpan per chat
- `dryRun=false` mengizinkan live execution untuk chat itu
- manual Telegram buy/sell tetap live

---

## Helius Integration

### Webhook Endpoint

```text
POST /helius/webhook
```

### Public URL

```text
https://my-solona-bot.apps.arulize.com/helius/webhook
```

### Auth Header

```http
Authorization: Bearer <HELIUS_WEBHOOK_SECRET>
```

### Webhook Use Cases

- discovery mint dari transfer token
- native SOL transfer detection untuk deposit balance
- real-time token intake tanpa polling

---

## Deployment

### CapRover

```bash
yarn deploy:vps
```

Pastikan environment di CapRover hanya berisi variable dari `.env.example`. File `config.json` ikut terkirim bersama source code dan dipakai sebagai sumber angka strategi.

---

## Pipeline and Simulation

| Mode / Parameter | Discovery & Behavior | Keterangan |
|------------------|----------------------|------------|
| `Hybrid pipeline` | Internal routing based on token age | `MICIN_ROUTE` untuk token < 2 jam, `WHALE_ROUTE` untuk token >= 2 jam |
| `config.json` | Non-secret thresholds and strategy tuning | Angka filter, sizing, dan regime diambil dari sini |
| `dryRun=true` | Signal-only mode | Live swaps di-skip |
| `dryRun=false` | Live Wallet Execution | Live swaps diizinkan untuk chat itu |

---

## Tech Stack

- Runtime: Node.js with NestJS (TypeScript)
- Database: PostgreSQL with Prisma ORM
- Blockchain: Solana Web3.js
- DEX: Jupiter Aggregator
- APIs: DexScreener, RugCheck, PumpPortal, Helius
- Deployment: CapRover

---

## Notes

- `SOLANA_RPC_URL` sekarang dipakai sebagai RPC utama dan tetap berada di `.env`
- `BOT_MODE` sudah deprecated. Bot selalu berjalan sebagai hybrid pipeline dengan internal route.
- `config.json` adalah sumber angka strategi dan threshold.
- `Watchlist` dipakai untuk retry/discovery state, bukan sebagai sumber volatilitas fresh di price monitor

*Last updated: Juni 2026 - hybrid pipeline, config.json strategy settings, Helius webhook, dynamic risk adjuster, in-memory market freshness, stop loss patience bypass, live Telegram control plane.*
