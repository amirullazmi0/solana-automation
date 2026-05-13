# 🚀 Solana Trend Follower Bot (Advanced Predator)

Bot otomatis untuk jaringan Solana yang fokus pada strategi **"Second Wave"** dan **Smart Momentum**. Didesain untuk mengejar koin yang sudah melewati fase konsolidasi dan siap untuk ledakan harga kedua.

## 🛡️ Core Features (Smart & Secure)

### 1. 🧠 Smart Retry Watchlist (Database-Backed)
Bot tidak akan melupakan koin potensial. Koin yang gagal filter sementara (terlalu muda, MCap kecil, atau tren bearish) akan disimpan di database **Watchlist** dan dipantau terus-menerus oleh background radar. Begitu kondisinya matang, bot langsung sikat!

### 2. 🪓 Advanced Trading Metrics
Menggunakan rumus matematis untuk membedakan koin "micin" biasa dengan koin yang punya potensi ledakan nyata:
*   **VoL (Velocity of Liquidity)**: Mengukur kecepatan aliran uang dibanding ketersediaan liquidity di pool.
*   **Volume Z-Score**: Deteksi anomali volume untuk menemukan jejak akumulasi "Whale" atau insider.
*   **Safety Index**: Analisa konsentrasi Top 10 Holders. Bot akan menolak koin jika Top 10 pegang > 30% supply.

### 3. 💎 Premium Telegram Alerts
Notifikasi real-time yang informatif dan premium:
*   Layout rapi dengan garis pemisah dan emoji.
*   Tombol akses cepat ke **DexScreener**, **RugCheck**, dan **Solscan**.
*   Indikator profit visual (🟢/🔴).

### 4. 🔒 Hardened Security
*   **DNS Hardening**: Fallback DoH (DNS over HTTPS) untuk menghindari manipulasi RPC.
*   **LP Burn Enforcement**: Wajib 100% Liquidity Burned.
*   **Mint Authority Check**: Wajib Mint Authority Disabled.
*   **Freeze Authority Check**: Wajib Freeze Authority Disabled.

## ⚙️ Configuration (.env)
Sesuaikan parameter trading kamu di file `.env`:
*   `MIN_LIQUIDITY_USD`: Minimal likuiditas di pool.
*   `MIN_MCAP` & `MAX_MCAP`: Range Market Cap target (Sweet Spot Second Wave).
*   `TRAILING_DISTANCE_PERCENT`: Jarak trailing stop untuk mengunci profit.
*   `STOP_LOSS_PERCENT`: Batas toleransi kerugian.

## 🛠 Tech Stack
*   **Runtime**: Node.js with NestJS (TypeScript)
*   **Database**: PostgreSQL with Prisma ORM
*   **Blockchain**: Solana Web3.js
*   **APIs**: Jupiter (Paid/Metis), DexScreener, RugCheck.

## 🚀 Quick Start
1.  `npm install`
2.  `npx prisma db push`
3.  `npm run dev`

---
*Created with ❤️ by Antigravity for Amirull Azmi.*

## 🏗️ Arsitektur

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ ScannerService  │─────▶│ AnalyzerService │─────▶│  TradeService   │
│ (Discovery)     │      // 🛡️ ADVANCED METRICS CHECK
                         // 1. VoL Check (Min 0.02 - Sedikit lebih agresif)
                         if (traction.volScore && traction.volScore < 0.02) {
                             this.logger.debug(`[${tokenMint}] Low VoL Score: ${traction.volScore.toFixed(4)}. Supply not shocked enough.`);
                             return { safe: false, reason: 'low_vol_score', metadata: baseMetadata };
                         }

                         // 2. Z-Score Anomaly Check (Z > 1.5 - Menangkap anomali lebih awal)
                         if (traction.zScore && traction.zScore < 1.5) {
                             this.logger.debug(`[${tokenMint}] Normal Volume (Z-Score: ${traction.zScore.toFixed(2)}). Waiting for anomaly...`);
                             return { safe: false, reason: 'no_volume_anomaly', metadata: baseMetadata };
                         }
└─────────────────┘      └─────────────────┘      └────────┬────────┘
                                                           │
                                                           ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ ReportingService│◀─────│ PriceMonitor    │◀─────│ Prisma (DB)     │
│ (Telegram Alert)│      │ (TP/SL/Trailing)│      │ (Persistence)   │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

---

## 📊 Monitoring (Telegram)

Bot mengirim notifikasi ke **Telegram** untuk:
- 🚀 **BUY ALERT**: Lengkap dengan link DexScreener & Socials.
- 📈 **TRAILING UPDATE**: Cooldown 5 menit agar tidak spam.
- 💰 **SELL ALERT**: Menampilkan % Profit/Loss asli.
- 🔍 **WATCHLIST**: Notifikasi koin potensial (Filter: MCap > $20k, Surge > 1.5x).

---

## 🚀 Deployment

```bash
# Install & Migrate
yarn install
yarn prisma migrate deploy

# Development
yarn start:dev

# Production
yarn build
yarn start:prod
```

*Last updated: Mei 2026 — Strategi: Trend Follower (Second Wave Micro-Cap)*
