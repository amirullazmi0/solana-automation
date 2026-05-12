# 🤖 Solana Trend Follower Bot

Bot trading otomatis berbasis **NestJS** untuk Solana — menggunakan strategi **Trend Follower (Second Wave)** yang menargetkan koin micro-cap potensial dari DexScreener.

---

## 🎯 Strategi: Second Wave Trend Follower

Bot **TIDAK** lagi sniper koin baru (0 menit). Strategi ini menargetkan koin yang:
- Sudah berumur **2-96 jam** (sniper bot sudah pergi)
- Market Cap **$10k - $300k** (sweet spot sebelum pump besar)
- Sedang ada **volume surge** (2x dari rata-rata) → tanda breakout
- Ada indikasi **smart money accumulation** (lebih banyak buy tx dari sell)

### 🧠 Kenapa Second Wave lebih menguntungkan?

| | Sniper (0 menit) | Trend Follower (2-96 jam) |
|---|---|---|
| Saingan | Bot monster dengan server dekat validator | Volume asli + komunitas |
| Risiko Rug | Sangat tinggi | Lebih rendah (sudah survive) |
| Slippage | Tinggi (30%+) | Rendah (3%) |
| Modal | Butuh modal besar | Cocok modal kecil |

---

## 🔍 Discovery Engine

Bot melakukan **polling setiap 30 detik** ke DexScreener Boosted Tokens API:
```
GET https://api.dexscreener.com/token-boosts/latest/v1
```

Koin yang masuk boosted list = ada anggaran marketing = ada harapan pump.

---

## 🛡️ Filter Berlapis (Gate System)

### Gate 1: MCap Range (Permanent)
```
MIN_MCAP = $10,000
MAX_MCAP = $300,000
```
Gagal → langsung give up, tidak di-retry.

### Gate 2: Age Check (Semi-Permanent)
```
MIN_AGE = 2 jam   (sniper bot sudah pergi)
MAX_AGE = 96 jam  (koin tidak terlalu tua)
```
- Koin < 1 jam → permanent fail
- Koin 1-2 jam → re-check setiap 30 detik (mungkin segera masuk window)
- Koin > 96 jam → permanent fail

### Gate 3: Volume Surge
```
Volume 5 menit terakhir > 2x rata-rata volume per 5 menit dalam 1 jam
```
Tanda breakout nyata, bukan sepi.

### Gate 4: Smart Money Accumulation
```
Buy Count > Sell Count (lebih banyak yang beli dari jual)
AND Harga bergerak < 5% (akumulasi diam-diam)
```

### Gate 5: Safety Check (via RPC)
- ✅ Mint Authority Disabled
- ✅ Freeze Authority Disabled  
- ✅ Liquidity Locked
- ✅ Min Liquidity: $5,000
- ✅ Min Volume: $1,000
- ✅ Min Buy Count: 20

---

## 💰 Trade Management

### Entry
- Position Size: **$7 per slot**
- Max Slots: **3 posisi bersamaan**
- Slippage: **3% (300 BPS)**
- Eksekusi via **Jupiter Aggregator**

### Exit
| Kondisi | Aksi |
|---|---|
| Profit +30% | Take Profit |
| Loss -25% (trailing) | Stop Loss |
| 3x konfirmasi di bawah SL | Confirmed Stop Loss (Anti-Shakeout) |
| Buy Pressure tinggi saat SL | Hold, reset SL counter |
| Dev jual > 50% | Panic Sell (PriceMonitor) |

### 🛡️ Anti-Shakeout (Confirmed Stop Loss)
Bot **TIDAK** langsung jual saat harga turun ke SL threshold. Harus 3x konfirmasi berturut-turut (interval harga monitor), KECUALI jika buy pressure masih tinggi → bot hold dan reset counter.

---

## ⚙️ Konfigurasi (.env)

```env
# Budget
TOTAL_CAPITAL=26
RESERVE_AMOUNT=5
TOTAL_SLOTS=3
POSITION_SIZE_USD=7

# Exit Strategy
TAKE_PROFIT_PERCENT=30.0
STOP_LOSS_PERCENT=25.0
TRAILING_DISTANCE_PERCENT=5.0
SLIPPAGE_BPS=300

# Filter
MIN_LIQUIDITY_USD=5000
MIN_VOLUME_USD=1000
MIN_BUY_COUNT=20
MIN_VL_RATIO=0.1
MIN_VOLUME_MCAP_RATIO=0.05

# MCap Range (Trend Follower Sweet Spot)
MIN_MCAP=10000
MAX_MCAP=300000
```

---

## 🏗️ Arsitektur

```
┌─────────────────────────────────────────┐
│             ScannerService              │
│   Polling DexScreener Boosts (30s)      │
│   → Deteksi kandidat Second Wave        │
└────────────────┬────────────────────────┘
                 │ tokenMint
                 ▼
┌─────────────────────────────────────────┐
│            AnalyzerService              │
│  Gate 1: MCap Filter ($10k-$300k)      │
│  Gate 2: Age Filter (2h-96h)           │
│  Gate 3: Volume Surge (2x)             │
│  Gate 4: Smart Money Accumulation      │
│  Gate 5: Safety (RPC Check)            │
└────────────────┬────────────────────────┘
                 │ passed ✅
                 ▼
┌─────────────────────────────────────────┐
│              TradeService               │
│   Jupiter Swap → Buy Token              │
│   Simpan ke DB (PostgreSQL + Prisma)    │
└────────────────┬────────────────────────┘
                 │ tradeId
                 ▼
┌─────────────────────────────────────────┐
│          PriceMonitorService            │
│   Monitor harga via Jupiter Price API   │
│   Confirmed SL (3x anti-shakeout)       │
│   Trailing Take Profit +30%             │
│   Panic Sell (Dev jual deteksi)         │
└─────────────────────────────────────────┘
```

---

## 🚀 Deployment

```bash
# Install dependencies
yarn install

# Generate Prisma Client + migrate
yarn prisma migrate deploy

# Build
yarn build

# Run production
yarn start:prod

# Deploy ke VPS
yarn deploy:vps
```

---

## 📊 Monitoring

Bot mengirim notifikasi ke **Telegram** untuk:
- 🟢 Buy berhasil
- 🔴 Sell (TP/SL/Panic)
- ⚠️ Error kritis
- 💰 Balance update

---

## 🔐 Keamanan

- Private key hanya di `.env` (JANGAN commit)
- DNS hardening dengan hardcoded IP untuk Jupiter API
- Force IPv4 untuk stabilitas koneksi VPS
- Semua API call menggunakan `https.Agent({ family: 4 })`

---

*Last updated: Mei 2026 — Strategi: Trend Follower (Second Wave Micro-Cap)*
