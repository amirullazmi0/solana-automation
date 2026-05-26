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
- **Safety Index** — Analisa konsentrasi Top 10 Holders (reject jika Top 10 pegang > 20% supply)

### 3. 💊 PumpFun Tolerance
Bot memahami mekanisme PumpFun:
- **Freeze Authority** — PumpFun tokens yang baru migrate WAJAR punya freeze auth sementara → ditoleransi
- **LP Locked** — Accept LP `locked` selain `burned` (mekanisme PumpFun berbeda dari Raydium standar)
- **Safety RPC** — 3x retry dengan backoff jika RPC error (bukan langsung reject)

### 4. 💎 Premium Telegram Alerts
Real-time Telegram notifications with detailed stats:
- 🚀 **BUY ALERT** — Lengkap dengan link DexScreener & Socials, total SOL Spent, harga SOL, dan estimasi nilai USD.
- 📈 **TRAILING UPDATE** — Cooldown 5 menit agar tidak spam.
- 💰 **SELL ALERT** — Menampilkan keuntungan bersih riil (SOL spent vs received, profit % SOL, nominal USD spent vs received, profit % USD, serta unit price dengan presisi 10 desimal SOL).
- 🔍 **WATCHLIST** — Notifikasi koin potensial (Second Wave Radar).

### 5. 🔒 Hardened Security & Capital Protection
- **Pre-Buy SOL Check** — Deteksi saldo SOL lokal sebelum buy untuk menyisakan `RESERVE_AMOUNT` (mencegah token tersangkut & gas fee sia-sia)
- **Preflight Simulation** — Mengaktifkan simulasi RPC (`skipPreflight: false`) demi meniadakan kerugian gas fee pada transaksi gagal (reverted on-chain)
- **Hard Crash Bypass** — Jual instan di -55% jika koin crash cepat, melompati delay Patience Protocol
- **DNS Hardening** — Fallback DoH (DNS over HTTPS) via Cloudflare & Google
- **IPv4 Force** — `https.Agent({ family: 4 })` untuk stabilitas VPS
- **LP Safety Check** — Wajib LP burned/locked
- **Mint Authority Check** — Wajib Mint Authority disabled
- **Anti-Repeat Buy (Dynamic Cooldown)** — Cooldown dinamis (6 jam jika profit, 24 jam jika rugi) per token
- **Anti-Honeypot** — Deteksi koin yang tidak bisa dijual

### 6. 🔥 Established Rebound & CTO Bot
Layanan kuantitatif khusus (`EstablishedAnalyzerService`) untuk mendeteksi anomali **"Dead Cat Bounce"** atau **"Community Take Over (CTO)"**:
- **Target Koin Mapan**: Umur 1-3 hari (24-72 jam) dengan likuiditas >= $3,000.
- **Deep Sell-off**: Telah mengalami koreksi mendalam dalam 24 jam ($\le -50\%$).
- **Volume-Price Divergence**: Mendeteksi akumulasi masif ($V_{5m} > V_{1h} \times 0.25$) dengan pergerakan harga 5m yang stabil (-2% s/d +5%) membentuk lantai baru.
- **Buyer Dominance**: Rasio beli vs jual $> 1.5\text{x}$ dengan minimal 5 transaksi beli.
- **Strict Custom Exit**: Eksekusi instan dengan aturan keluar ketat mandiri (TP 18%, TSL 2.5%, Hard SL 20%).

---

## 🏗️ Arsitektur

```
┌─────────────────┐      ┌──────────────────────────────┐      ┌─────────────────┐
│ ScannerService  │─────▶│ EstablishedAnalyzerService   │─────▶│  TradeService   │
│ (Discovery)     │      │ (Rebound & CTO Detector)     │      │ (Jupiter Swap)  │
│                 │      └──────────────┬───────────────┘      │                 │
│ • PumpPortal WS │                     │ Gagal Rebound        │ • Buy/Sell      │
│ • DexScreener   │                     ▼                      │ • Dynamic Fees  │
│ • Watchlist DB  │      ┌──────────────────────────────┐      │ • Retry + Slip  │
│                 │─────▶│ AnalyzerService              │─────▶│                 │
└─────────────────┘      │ (12-Gate Standard Filter)    │      └────────┬────────┘
                         └──────────────────────────────┘               │
                                                                        ▼
┌─────────────────┐      ┌──────────────────────────────┐      ┌─────────────────┐
│ ReportingService│◀─────│ PriceMonitor                 │◀─────│ Prisma (DB)     │
│ (Telegram Alert)│      │ (TP/SL/Trail + Custom Exit)  │      │ (PostgreSQL)    │
└─────────────────┘      └──────────────────────────────┘      └─────────────────┘
```

---

## ⚙️ Configuration

Salin `.env.example` ke `.env` dan isi value-nya. Semua parameter sudah diberi komentar penjelasan.

### Filter Thresholds (Recommended)
| Parameter | Value | Keterangan |
|-----------|-------|------------|
| `ANALYZER_MIN_Z_SCORE` | `1.5` | Volume anomaly detection (lebih rendah = lebih agresif) |
| `ANALYZER_MIN_VOL_SCORE` | `0.02` | Kecepatan uang masuk pool |
| `ANALYZER_MIN_VOLUME_SURGE` | `1.5` | Volume saat ini vs rata-rata |
| `MIN_BUY_CONFIDENCE` | `0.60` | Rasio buyer vs seller |
| `MIN_LIQUIDITY_USD` | `7500` | Minimum liquidity di pool |
| `MIN_BUY_COUNT` | `5` | Minimum buyer dalam 5 menit |

### Established Rebound & CTO Thresholds
| Parameter | Value | Keterangan |
|-----------|-------|------------|
| `ESTABLISHED_MIN_AGE_HOURS` | `24` | Umur minimum token (jam) |
| `ESTABLISHED_MAX_AGE_HOURS` | `72` | Umur maksimum token (jam) |
| `ESTABLISHED_MIN_BUYS` | `5` | Minimum buyer dalam 5 menit untuk rebound |
| `MIN_ESTABLISHED_LIQUIDITY` | `3000` | Minimum likuiditas (USD) |
| `MAX_ESTABLISHED_MCAP` | `200000` | Maksimum kapitalisasi pasar (USD) |
| `REBOUND_PRICE_DROP_PCT` | `-50` | Syarat penurunan harga dalam 24 jam |
| `VOLUME_SPIKE_RATIO` | `0.25` | Syarat lonjakan volume $V_{5m}$ thd $V_{1h}$ |
| `BUY_SELL_RATIO_THRESHOLD` | `1.5` | Rasio dominasi pembeli vs penjual |

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
PASS jika: liquidity >= MIN_LIQUIDITY_USD ($7,500)
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
PASS jika: MIN_AGE_HOURS (0.02h/~1min) <= age <= MAX_AGE_HOURS (72h)
FAIL: too_young (temporary) | too_old (temporary)
```
> Koin < 1 menit terlalu berisiko (bisa scam). Koin > 72 jam disaring ke mode Established Rebound.

#### Gate 4: Volume Surge
```
volumeSurge = volume_5m / avgVolume_5m
avgVolume_5m = volume_1h / 12

PASS jika: volumeSurge >= ANALYZER_MIN_VOLUME_SURGE (1.5x)
FAIL: low_surge (temporary)
```
> Memastikan volume saat ini **minimal sama** dengan rata-rata. Surge > 1 = volume naik.

#### Gate 5: Price Trend
```
PASS jika: priceChange_1h > -15%
FAIL: bearish_trend (permanent)
```
> Jangan beli koin yang sedang downtrend tajam. Tunggu reversal.

#### Gate 6: Buy Confidence Score
```
confidenceScore = buys_5m / (buys_5m + sells_5m)

PASS jika: confidenceScore >= MIN_BUY_CONFIDENCE (0.60)
FAIL: low_buy_confidence (temporary)
```
> 60% buyer artinya ada demand yang lebih kuat dari supply. Di bawah itu = orang lebih banyak jual.

#### Gate 7: Base Metrics Combo
```
PASS jika:
  - liquidity >= MIN_LIQUIDITY_USD ($7,500)
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
  1. Safety Index = 1 - (top10HolderSupply / totalSupply) >= 0.80
  2. LP Status = 'burned' ATAU 'locked' (PumpFun skip jika no market data)
  3. Risk Score <= 1000
  4. Tidak ada risk: 'honeypot', 'freeze', 'mint authority'
  5. Danger level risks = 0
  6. Creator balance <= 5% dari total supply

FAIL: high_concentration | lp_not_burned | high_risk_score | honeypot_detected | creator_holds_too_much
```

### 🎯 Decision Flow (Summary)

```
Token ditemukan (via Polling atau WS)
    │
    ▼
[Garda Depan: Rebound & CTO Check] ──PASS──▶ 🚀 EXECUTE BUY (Rebound Custom Exit)
    │ FAIL
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
🚀 EXECUTE BUY via Jupiter Swap (Standard Exit)
    │
    ▼
PriceMonitorService mulai tracking:
  • Take Profit standar (30%) / CTO (18%) → Trailing Stop aktif
  • Stop Loss standar (25%) / CTO (20%) → Auto-sell dengan slippage 15%
  • Trailing Stop standar (5%) / CTO (2.5%) → Kunci profit, sell jika turun dari peak
```

### 📈 Exit Strategy & Profit Optimizations (PriceMonitorService)

| Kondisi | Aksi | Slippage |
|---------|------|----------|
| Price naik ≥ `TAKE_PROFIT_PERCENT` (Standard: 30% / CTO: 18%) | Trailing Stop **aktif** | Normal (5%) |
| Price turun ≥ `TRAILING_DISTANCE_PERCENT` (Standard: 5% / CTO: 2.5%) dari peak | **SELL** (Trailing Stop) | Normal (5%) |
| Price turun ≥ `STOP_LOSS_PERCENT` (Standard: 25% / CTO: 20%) dari entry | **SELL** (Stop Loss) | Panic (15%) |
| Dev dump terdeteksi (creator sell >50%) | **SELL** (Rugpull) | Panic (15%) |

#### ⚡ Optimasi Profitabilitas Tambahan:
- **Dynamic Take Profit**: Jika koin sangat kencang dan highest price mencapai **1.35x dari harga beli**, target TP secara dinamis disesuaikan menjadi **50%** (dari standard 30%) untuk membiarkan profit berlari namun tetap realistis (menghindari keserakahan).
- **Flexible Trailing Stop**: Trailing Stop (TSL) dibiarkan bergerak bebas mengikuti fluktuasi harga (jarak 5% penuh dari peak) tanpa dikunci terlalu dini di dekat break-even.
- **Zero-Loss Protection (Safe Zone)**: Ketika profit koin telah menyentuh minimal **15%**, stop loss otomatis dinaikkan ke minimal `harga_beli + 2%` untuk menutupi fee gas/Priority Fee.
- **Patience Protocol (SL Delay)**: Ketika harga menyentuh zona stop loss, bot menunggu **5 menit** untuk melihat volume/tekanan beli pemulihan, dengan batas keras (*hard cap*) **10 menit** untuk meminimalkan kerugian lebih dalam.

> **🔥 Catatan Khusus untuk Mode Established Rebound & CTO:**
> Transaksi yang dibuka melalui jalur Rebound & CTO memiliki exit rules kustom mandiri (`targetTakeProfit=18%`, `targetTrailingDistance=2.5%`, dan `targetStopLoss=20%`). `PriceMonitorService` secara otomatis menggunakan nilai kustom ini tanpa dipengaruhi konfigurasi standar bot.

### 🔄 Watchlist Retry Mechanism

Token yang gagal karena alasan **temporary** tidak langsung dibuang:

| Fail Reason | Retry? | Keterangan |
|-------------|--------|------------|
| `too_young` | ✅ | Tunggu sampai cukup umur |
| `mcap_too_low` | ✅ | Tunggu MCap naik |
| `low_surge` | ✅ | Tunggu volume surge |
| `safety_rpc_failed` | ✅ | Retry 3x, lalu watchlist |
| `bearish_trend` | ❌ | Permanent — downtrend tajam |
| `low_buy_confidence` | ✅ | Tunggu lebih banyak buyer |
| `too_old` | ✅ | Temporary — jika umur di bawah `ESTABLISHED_MAX_AGE_HOURS` (72 jam) |
| `mcap_too_high` | ❌ | Permanent — sudah terlalu besar |
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

## 📊 Bot Modes & Simulation

| Mode / Parameter | Discovery & Behavior | Keterangan |
|------------------|----------------------|------------|
| `BOT_MODE=whale` | DexScreener only | Polling koin mapan ($50K-$300K MCap) tanpa WebSocket |
| `BOT_MODE=micin` | PumpPortal WS + DexScreener | Menangkap koin baru migrate dari Pump.fun secara instan via WebSocket |
| `DRY_RUN=true` | Mainnet Quotes + Database Simulation | Menjalankan seluruh filter live, namun mencegat eksekusi asli tepat sebelum penandatanganan dompet. Aman untuk uji coba tanpa risiko kehilangan modal. Di Telegram ditandai dengan `🤖 [SIMULASI]`. |
| `DRY_RUN=false` | Live Wallet Execution | Transaksi nyata di blockchain Solana menggunakan saldo asli. |

Set via `.env`.

---

*Last updated: Mei 2026 — Strategi: Capital Protection & Risk Management (Round 11-16)*
*Created with ❤️ by Antigravity for Amirull Azmi.*
