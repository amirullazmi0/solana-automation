# 🚀 Solana Trend Follower Bot (MaSoul Sniper)

Bot trading otomatis untuk **Solana** yang fokus pada strategi **"Second Wave"** dan **Smart Momentum**. Didesain untuk menangkap koin yang sudah melewati fase awal dan siap untuk ledakan harga kedua.

**Target: $5/hari dari modal $20.**

---

## 🛡️ Core Features

### 1. 🧠 Smart Retry Watchlist (Database-Backed)
Bot tidak melupakan koin potensial. Koin yang gagal filter **sementara** (terlalu muda, MCap kecil, volume belum cukup) disimpan di database **Watchlist** dan dipantau terus oleh background radar. Begitu kondisinya matang → langsung beli!

### 2. 🪓 Advanced Trading Metrics
Rumus matematis untuk membedakan koin "micin" biasa dengan koin yang punya potensi ledakan nyata:
- **VoL (Velocity of Liquidity)** — Kecepatan aliran uang dibanding ketersediaan liquidity di pool
- **Volume Z-Score** — Deteksi anomali volume untuk menemukan jejak akumulasi Whale/insider
- **Safety Index** — Analisa konsentrasi Top 10 Holders (reject jika Top 10 pegang > 30% supply)

### 3. 💊 PumpFun Tolerance
Bot memahami mekanisme PumpFun:
- **Freeze Authority** — PumpFun tokens yang baru migrate WAJAR punya freeze auth sementara → ditoleransi
- **LP Locked** — Accept LP `locked` selain `burned` (mekanisme PumpFun berbeda dari Raydium standar)
- **Safety RPC** — 3x retry dengan backoff jika RPC error (bukan langsung reject)

### 4. 💎 Premium Telegram Alerts
Notifikasi real-time yang informatif:
- 🚀 **BUY ALERT** — Lengkap dengan link DexScreener & Socials
- 📈 **TRAILING UPDATE** — Cooldown 5 menit agar tidak spam
- 💰 **SELL ALERT** — Menampilkan % Profit/Loss asli
- 🔍 **WATCHLIST** — Notifikasi koin potensial (Second Wave Radar)

### 5. 🔒 Hardened Security
- **DNS Hardening** — Fallback DoH (DNS over HTTPS) via Cloudflare & Google
- **IPv4 Force** — `https.Agent({ family: 4 })` untuk stabilitas VPS
- **LP Safety Check** — Wajib LP burned/locked
- **Mint Authority Check** — Wajib Mint Authority disabled
- **Anti-Repeat Buy** — Cooldown 24 jam per token
- **Anti-Honeypot** — Deteksi koin yang tidak bisa dijual

---

## 🏗️ Arsitektur

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ ScannerService  │─────▶│ AnalyzerService │─────▶│  TradeService   │
│ (Discovery)     │      │ (12-Gate Filter)│      │ (Jupiter Swap)  │
│                 │      │                 │      │                 │
│ • PumpPortal WS │      │ • Liquidity     │      │ • Buy/Sell      │
│ • DexScreener   │      │ • MCap Range    │      │ • Dynamic Fees  │
│ • Watchlist DB  │      │ • VoL Score     │      │ • Retry + Slip  │
│                 │      │ • Z-Score       │      │                 │
└─────────────────┘      │ • Safety RPC    │      └────────┬────────┘
                         │ • RugCheck      │               │
                         └─────────────────┘               ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ ReportingService│◀─────│ PriceMonitor    │◀─────│ Prisma (DB)     │
│ (Telegram Alert)│      │ (TP/SL/Trail)   │      │ (PostgreSQL)    │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

---

## ⚙️ Configuration

Salin `.env.example` ke `.env` dan isi value-nya. Semua parameter sudah diberi komentar penjelasan.

### Filter Thresholds (Recommended)
| Parameter | Value | Keterangan |
|-----------|-------|------------|
| `ANALYZER_MIN_Z_SCORE` | `1.5` | Volume anomaly detection (lebih rendah = lebih agresif) |
| `ANALYZER_MIN_VOL_SCORE` | `0.02` | Kecepatan uang masuk pool |
| `ANALYZER_MIN_VOLUME_SURGE` | `1.0` | Volume saat ini vs rata-rata |
| `MIN_BUY_CONFIDENCE` | `0.55` | Rasio buyer vs seller |
| `MIN_LIQUIDITY_USD` | `3000` | Minimum liquidity di pool |
| `MIN_BUY_COUNT` | `5` | Minimum buyer dalam 5 menit |

---

## 🛠 Tech Stack
- **Runtime**: Node.js with NestJS (TypeScript)
- **Database**: PostgreSQL with Prisma ORM
- **Blockchain**: Solana Web3.js
- **DEX**: Jupiter Aggregator (Paid API / Metis)
- **APIs**: DexScreener, RugCheck, PumpPortal
- **Deployment**: CapRover (Docker)

---

## 🚀 Quick Start

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

## 🧮 Algoritma & Filter Pipeline

### Overview
Setiap token yang ditemukan oleh Scanner harus melewati **12 gate filter** secara berurutan. Jika gagal di satu gate, token di-reject (atau disimpan di Watchlist untuk retry jika bersifat temporary).

### 📡 Discovery Layer (ScannerService)

Bot menemukan token dari 3 sumber secara paralel:

| Sumber | Metode | Kecepatan |
|--------|--------|-----------|
| **PumpPortal WS** | WebSocket real-time (Raydium migrations) | ~instant |
| **DexScreener Boosts** | Polling API (token dengan marketing budget) | 3 detik |
| **DexScreener Profiles** | Polling API (trending organic) | 3 detik |

Token yang ditemukan masuk ke `processNewToken()` → di-upsert ke **Watchlist DB** sebagai `PENDING` → di-loop sampai lolos atau timeout.

### 🔬 Analyzer Layer — 12-Gate Filter

Setiap token harus melewati gate ini **secara berurutan**:

#### Gate 1: Liquidity Check
```
PASS jika: liquidity >= MIN_LIQUIDITY_USD ($3,000)
FAIL: zero_liquidity (permanent jika koin > 1 jam tapi liq tetap 0)
```
> Koin tanpa liquidity = mustahil dijual tanpa slippage besar.

#### Gate 2: Market Cap Range
```
PASS jika: MIN_MCAP ($5,000) <= MCap <= MAX_MCAP ($300,000)
FAIL: mcap_too_low (temporary) | mcap_too_high (permanent)
```
> Sweet spot "Second Wave" — terlalu kecil = belum terbukti, terlalu besar = sudah telat.

#### Gate 3: Token Age
```
PASS jika: MIN_AGE_HOURS (0.02h/~1min) <= age <= MAX_AGE_HOURS (24h)
FAIL: too_young (temporary) | too_old (permanent)
```
> Koin < 1 menit terlalu berisiko (bisa scam). Koin > 24 jam sudah kehilangan momentum.

#### Gate 4: Volume Surge
```
volumeSurge = volume_5m / avgVolume_5m
avgVolume_5m = volume_1h / 12

PASS jika: volumeSurge >= ANALYZER_MIN_VOLUME_SURGE (1.0x)
FAIL: low_surge (temporary)
```
> Memastikan volume saat ini **minimal sama** dengan rata-rata. Surge > 1 = volume naik.

#### Gate 5: Price Trend
```
PASS jika: priceChange_1h > -15%
FAIL: bearish_trend (temporary)
```
> Jangan beli koin yang sedang downtrend tajam. Tunggu reversal.

#### Gate 6: Buy Confidence Score
```
confidenceScore = buys_5m / (buys_5m + sells_5m)

PASS jika: confidenceScore >= MIN_BUY_CONFIDENCE (0.55)
FAIL: low_buy_confidence (temporary)
```
> 55% buyer artinya ada demand yang lebih kuat dari supply. Di bawah itu = orang lebih banyak jual.

#### Gate 7: Base Metrics Combo
```
PASS jika:
  - liquidity >= MIN_LIQUIDITY_USD ($3,000)
  - volume_5m >= MIN_VOLUME_USD ($500)
  - buys_5m >= MIN_BUY_COUNT (5)
FAIL: low_metrics (temporary)
```
> Minimum "tanda kehidupan" — koin harus aktif diperdagangkan.

#### Gate 8: Velocity (Volume/MCap Ratio)
```
velocity = volume_5m / marketCap

PASS jika: velocity >= MIN_VOLUME_MCAP_RATIO (0.05)
FAIL: low_velocity (temporary)
```
> Seberapa aktif trading relatif terhadap ukuran koin. Velocity 0.05 = 5% dari MCap ditransaksikan dalam 5 menit.

#### Gate 9: VoL Score (Velocity of Liquidity)
```
VoL = (volume_5m / liquidity) × confidenceScore

PASS jika: VoL >= ANALYZER_MIN_VOL_SCORE (0.02)
FAIL: low_vol_score (temporary)
```
> Rumus custom yang menggabungkan **kecepatan uang masuk pool** dengan **rasio buyer**. VoL tinggi = uang masuk deras dan mayoritas beli.

#### Gate 10: Z-Score (Volume Anomaly Detection)
```
avgVol_5m = volume_1h / 12
Z = (volume_5m - avgVol_5m) / (avgVol_5m × 0.5)

PASS jika: Z >= ANALYZER_MIN_Z_SCORE (1.5)
FAIL: no_volume_anomaly (temporary)
```
> **Pseudo Z-Score** untuk deteksi anomali. Z > 1.5 artinya volume 5 menit terakhir **1.75x lebih tinggi** dari rata-rata → kemungkinan ada Whale/insider yang masuk.

#### Gate 11: Safety RPC (On-Chain Authority Check)
```
mintInfo = getMint(connection, tokenMint)  // Solana RPC call

PASS jika:
  - mintInfo.mintAuthority === null     (tidak bisa cetak token baru)
  - mintInfo.freezeAuthority === null   (tidak bisa freeze akun)
  - ATAU token PumpFun + freezeAuth → TOLERATED

FAIL: safety_rpc_failed (temporary, retry 3x)
```
> Cek langsung on-chain. Jika mint authority masih aktif = dev bisa inflate supply kapan saja = **RUG**. PumpFun tokens sering punya freeze auth sementara setelah migration → ditoleransi.

#### Gate 12: RugCheck API (Advanced Safety)
```
Sub-checks (harus SEMUA pass):
  1. Safety Index = 1 - (top10HolderSupply / totalSupply) >= 0.70
  2. LP Status = 'burned' ATAU 'locked' (PumpFun skip jika no market data)
  3. Risk Score <= 2000
  4. Tidak ada risk: 'honeypot', 'freeze', 'mint authority'
  5. Tidak ada 'danger' level risks
  6. Creator balance <= 5% dari total supply

FAIL: high_concentration | lp_not_burned | high_risk_score | honeypot_detected | creator_holds_too_much
```

### 🎯 Decision Flow (Summary)

```
Token ditemukan
    │
    ▼
[Gate 1-8: Market Traction] ──FAIL──▶ Temporary? → Simpan di Watchlist (retry)
    │                                  Permanent? → FAILED (blacklist 2 jam)
    │ PASS
    ▼
[Gate 9-10: Advanced Metrics] ──FAIL──▶ Retry di Watchlist
    │ PASS
    ▼
[Gate 11: Safety RPC] ──FAIL──▶ Retry 3x, lalu simpan di Watchlist
    │ PASS
    ▼
[Gate 12: RugCheck] ──FAIL──▶ FAILED
    │ PASS
    ▼
🚀 EXECUTE BUY via Jupiter Swap
    │
    ▼
PriceMonitorService mulai tracking:
  • Take Profit (30%) → Trailing Stop aktif
  • Stop Loss (25%) → Auto-sell dengan slippage 15%
  • Trailing Stop (5%) → Kunci profit, sell jika turun 5% dari peak
```

### 📈 Exit Strategy (PriceMonitorService)

| Kondisi | Aksi | Slippage |
|---------|------|----------|
| Price naik ≥ `TAKE_PROFIT_PERCENT` | Trailing Stop **aktif** | Normal (5%) |
| Price turun ≥ `TRAILING_DISTANCE_PERCENT` dari peak | **SELL** (Trailing Stop) | Normal (5%) |
| Price turun ≥ `STOP_LOSS_PERCENT` dari entry | **SELL** (Stop Loss) | Panic (15%) |
| Dev dump terdeteksi (creator sell >50%) | **SELL** (Rugpull) | Panic (15%) |

### 🔄 Watchlist Retry Mechanism

Token yang gagal karena alasan **temporary** tidak langsung dibuang:

| Fail Reason | Retry? | Keterangan |
|-------------|--------|------------|
| `too_young` | ✅ | Tunggu sampai cukup umur |
| `mcap_too_low` | ✅ | Tunggu MCap naik |
| `low_surge` | ✅ | Tunggu volume surge |
| `safety_rpc_failed` | ✅ | Retry 3x, lalu watchlist |
| `bearish_trend` | ✅ | Tunggu reversal |
| `low_buy_confidence` | ✅ | Tunggu lebih banyak buyer |
| `mcap_too_high` | ❌ | Permanent — sudah terlalu besar |
| `too_old` | ❌ | Permanent — sudah terlalu tua |
| `honeypot` | ❌ | Permanent — scam |

Background Radar re-check setiap **10 detik** untuk 20 token PENDING terbaru.
Watchlist auto-cleanup: token > 24 jam yang masih FAILED/PENDING dihapus otomatis.

---

## 🚢 Deployment (CapRover)

```bash
# Deploy ke VPS via CapRover
yarn deploy:vps

# Atau dengan default config
caprover deploy --default
```

---

## 📊 Bot Modes

| Mode | Discovery | Target | Keterangan |
|------|-----------|--------|------------|
| `whale` | DexScreener only | $50K-$300K MCap | Second Whale — koin yang sudah established |
| `micin` | PumpPortal WS + DexScreener | $5K-$300K MCap | Micin Sniper — koin baru migrate dari PumpFun |

Set via `BOT_MODE=micin` di `.env`.

---

*Last updated: Mei 2026 — Strategi: Lean Filter Sniper (PumpFun Tolerance)*
*Created with ❤️ by Antigravity for Amirull Azmi.*
