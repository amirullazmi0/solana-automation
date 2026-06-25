# Solana Trend Follower Bot (MaSoul Sniper)

Bot trading otomatis untuk **Solana** yang fokus pada strategi **Second Wave** dan **Smart Momentum**. Didesain untuk menangkap koin yang sudah melewati fase awal dan siap untuk ledakan harga kedua.

**Target lama tetap sama: $5/hari dari modal $20.**

---

## Core Features

### 1. Smart Retry Watchlist (Database-Backed)
Bot tidak melupakan koin potensial. Koin yang gagal filter sementara, seperti terlalu muda, MCap kecil, atau volume belum cukup, disimpan di database **Watchlist** dan dipantau terus oleh background radar. Begitu kondisinya matang, token bisa masuk lagi ke jalur analisis.

Catatan update:
- Watchlist masih dipakai untuk retry dan discovery state.
- Jalur price monitor sekarang tidak lagi membaca `volScore` dan `priceChange1h` dari Watchlist.
- Sinyal volatilitas untuk risk adjuster sekarang diambil dari snapshot market fresh di memori.

### 2. Advanced Trading Metrics
Rumus matematis untuk membedakan koin micin biasa dengan koin yang punya potensi ledakan nyata:

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
  -> AnalyzerService (12-gate standard filter)
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

Salin `.env.example` ke `.env` dan isi value-nya. Parameter utama yang relevan:

| Parameter | Value | Keterangan |
|-----------|-------|------------|
| `ANALYZER_MIN_Z_SCORE` | `1.5` | Volume anomaly detection |
| `ANALYZER_MIN_VOL_SCORE` | `0.02` | Kecepatan uang masuk pool |
| `ANALYZER_MIN_VOLUME_SURGE` | `1.5` | Volume saat ini vs rata-rata |
| `MIN_BUY_CONFIDENCE` | `0.60` | Rasio buyer vs seller |
| `MIN_LIQUIDITY_USD` | `7500` | Minimum liquidity di pool |
| `MIN_BUY_COUNT` | `5` | Minimum buyer dalam 5 menit |
| `TAKE_PROFIT_PERCENT` | `30.0` | TP standar |
| `STOP_LOSS_PERCENT` | `25.0` | SL standar |
| `TRAILING_DISTANCE_PERCENT` | `5.0` | TSL standar |
| `DISABLE_SL_PATIENCE` | `false` | Patience protocol bisa dimatikan |
| `SL_PATIENCE_NEW_TOKEN_MINUTES` | `30` | Bypass patience untuk token baru |

### AI Analysis Layer

| Parameter | Keterangan |
|-----------|------------|
| `OPENAI_API_KEY` | Jika valid, `AnalyzerService` akan menjalankan `AIService.analyzeToken()` setelah filter market/RPC/RugCheck lulus |
| `AI_CONVICTION_THRESHOLD` | Minimum skor AI agar token boleh lanjut buy |
| `WHALE_SIGNAL_SCORE_FLOOR` | Minimum skor whale mode sebelum token sosialnya dianggap terlalu lemah untuk diproses lebih lanjut |

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

- `SOLANA_RPC_URL` - RPC utama, sekarang diarahkan ke Helius
- `HELIUS_WEBHOOK_SECRET` - Bearer secret untuk webhook
- `TELEGRAM_BOT_TOKEN` - token bot Telegram
- `TELEGRAM_CHAT_IDS` - allowlist chat untuk mode development
- `DATABASE_URL` - koneksi PostgreSQL
- `JUPITER_API_KEY` - API key Jupiter

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

Setiap token yang ditemukan oleh Scanner harus melewati 12 gate filter secara berurutan. Jika gagal di satu gate, token di-reject atau disimpan di Watchlist untuk retry jika bersifat temporary.

### Discovery Layer (ScannerService)

Bot menemukan token dari beberapa sumber:

| Sumber | Metode | Kecepatan |
|--------|--------|-----------|
| PumpPortal WS | WebSocket real-time | ~instant |
| DexScreener Boosts | Polling API | 3 detik |
| DexScreener Profiles | Polling API | 3 detik |
| Helius Enhanced Webhook | HTTP POST | real-time |

Token yang ditemukan masuk ke `processNewToken()` dan di-upsert ke Watchlist sebagai `PENDING`.

### Analyzer Layer - 12 Gate Filter

#### Gate 1: Liquidity Check

```text
PASS jika: liquidity >= MIN_LIQUIDITY_USD ($7,500)
FAIL: zero_liquidity
```

#### Gate 2: Market Cap Range

```text
PASS jika: MIN_MCAP ($5,000) <= MCap <= MAX_MCAP ($300,000)
FAIL: mcap_too_low | mcap_too_high
```

#### Gate 3: Token Age

```text
PASS jika: MIN_AGE_HOURS (~1 menit) <= age <= MAX_AGE_HOURS (72h)
FAIL: too_young | too_old
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
  - liquidity >= MIN_LIQUIDITY_USD ($7,500)
  - volume_5m >= MIN_VOLUME_USD ($500)
  - buys_5m >= MIN_BUY_COUNT (5)
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

- Take Profit standar 30% / CTO 18% -> partial take profit lalu trailing stop aktif
- Zero-Loss Protection -> saat profit >= 15%, trailing stop minimal naik ke `entryPrice + 2%`
- Stop Loss standar 25% / CTO 20% -> Patience Protocol 5 menit, hard cap 10 menit
- Hard crash -55% -> `PANIC_SELL` instan dengan slippage 15%
- Trailing Stop standar 5% / CTO 2.5% -> sell jika harga turun dari peak ke trailing stop

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

- market normal -> 5.0%
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

- `SOLANA_RPC_URL` sekarang dipakai sebagai RPC utama
- `Watchlist` dipakai untuk retry/discovery state, bukan sebagai sumber volatilitas fresh di price monitor
- readme ini sengaja mempertahankan rumus dan pipeline lama, lalu hanya menambahkan fitur baru yang memang sudah ada di codebase

*Last updated: Juni 2026 - Helius webhook, dynamic risk adjuster, in-memory market freshness, stop loss patience bypass, live Telegram control plane.*
