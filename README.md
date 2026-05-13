# 🤖 Solana Trend Follower Bot

Bot trading otomatis berbasis **NestJS** untuk Solana — menggunakan strategi **Trend Follower (Second Wave)** yang menargetkan koin micro-cap potensial dari DexScreener.

---

## 🎯 Strategi: Second Wave Trend Follower

Bot **TIDAK** lagi sniper koin baru (0 menit). Strategi ini menargetkan koin yang:
- Sudah berumur **2-96 jam** (sniper bot sudah pergi)
- Market Cap **$30k - $150k** (sweet spot untuk koin yang sudah "establish")
- Sedang ada **volume surge** (1.5x dari rata-rata) → tanda breakout
- Ada indikasi **smart money accumulation** (lebih banyak buy tx dari sell)

### 🧠 Kenapa Second Wave lebih menguntungkan?

| Fitur | Sniper (0 menit) | Trend Follower (2-96 jam) |
|---|---|---|
| Saingan | Bot monster & MEV | Volume asli + komunitas |
| Risiko Rug | Sangat tinggi (99%) | Lebih rendah (sudah survive) |
| Slippage | Tinggi (30%+) | Menengah (3-5%) |
| Modal | High Risk | Optimized Risk |

---

## 🔍 Discovery Engine

Bot melakukan **polling setiap 30 detik** ke DexScreener API untuk memantau:
1. **Boosted Tokens**: Koin yang sedang dipromosikan (marketing budget aktif).
2. **Trending Profiles**: Koin yang sedang ramai dibicarakan secara organik.

---

## 🛡️ Filter Berlapis (Gate System)

### Gate 1: MCap Range (Permanent)
```
MIN_MCAP = $30,000
MAX_MCAP = $150,000
```
Gagal → langsung abaikan, tidak di-retry.

### Gate 2: Age Check (Semi-Permanent)
```
MIN_AGE = 2 jam   (anti-sniper)
MAX_AGE = 96 jam  (koin belum 'mati')
```

### Gate 3: Volume Surge
```
Volume 5 menit terakhir > 1.5x rata-rata volume per 5 menit dalam 1 jam
```

### Gate 4: Security Check (Hardened)
- ✅ **Mint Authority**: Disabled (No more printing tokens)
- ✅ **Freeze Authority**: Disabled (No more honeypots)
- ✅ **RugCheck API**: Score < 3000 & No "Danger" level risks.
- ✅ **Min Liquidity**: $5,000
- ✅ **Min Volume**: $1,000

---

## 💰 Trade Management

### Entry
- **Max Slots**: 4 posisi bersamaan.
- **Position Size**: Diambil dari `(Total Capital - Reserve) / Slots`.
- **Slippage**: **100 BPS (1%)** default (bisa disesuaikan).
- **Priority Fee**: 2x auto-multiplier (biar transaksi cepat masuk).

### Exit
| Kondisi | Aksi |
|---|---|
| Profit +20% | Quick Take Profit |
| Trailing Stop | Terpaku pada harga tertinggi saat profit > 3% |
| Loss -40% | Stop Loss (dengan 3x konfirmasi) |
| Dev Jual > 15% | **Panic Sell** (Deteksi Dump Creator) |
| Likuiditas Turun > 35% | **Rugpull Protection** (Panic Sell) |

### 🛡️ Anti-Shakeout (Confirmed Stop Loss)
Bot **TIDAK** langsung jual saat harga menyentuh SL. Bot menunggu 3x konfirmasi harga di bawah threshold, KECUALI jika **Buy Pressure** terdeteksi masih tinggi (Pembeli > 2x Penjual).

---

## ⚙️ Konfigurasi (.env)

```env
# Wallet & RPC
PRIVATE_KEY=your_key
RPC_ENDPOINT=https://...
WSS_ENDPOINT=wss://...

# Budgeting
TOTAL_CAPITAL=20
RESERVE_AMOUNT=5
TOTAL_SLOTS=4

# Exit Strategy
TAKE_PROFIT_PERCENT=20.0
STOP_LOSS_PERCENT=40.0
TRAILING_DISTANCE_PERCENT=1.5
SLIPPAGE_BPS=100
```

---

## 🏗️ Arsitektur

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ ScannerService  │─────▶│ AnalyzerService │─────▶│  TradeService   │
│ (Discovery)     │      │ (Safety Check)  │      │ (Execution)     │
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
