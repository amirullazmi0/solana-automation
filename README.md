# 🦅 Solana Sniper & Scalper Bot v2.0

![Solana Sniper](https://img.shields.io/badge/Solana-Sniper-blueviolet?style=for-the-badge&logo=solana)
![Status](https://img.shields.io/badge/Status-Active-success?style=for-the-badge)
![Network](https://img.shields.io/badge/Network-Mainnet-orange?style=for-the-badge)

Bot Sniper Solana otomatis yang dirancang untuk kecepatan tinggi, keamanan maksimal, dan manajemen portofolio interaktif via Telegram. Bot ini memantau koin baru di **Pump.fun**, **Raydium**, dan **DexScreener** secara real-time.

---

## 🚀 Fitur Unggulan

- **🎯 Ultra-Fast Sniping**: Memantau koin baru langsung dari WebSocket Pump.fun dan Raydium.
- **🛡️ 3-Layer Security Filter**: 
  - **RugCheck API Integration**: Otomatis menolak koin dengan skor risiko tinggi.
  - **Authority Check**: Memastikan Mint & Freeze Authority sudah dimatikan.
  - **Liquidity Guard**: Memastikan koin memiliki likuiditas awal yang cukup.
- **🤖 Interactive Telegram Bot**: Cek saldo, status trading, dan kontrol bot langsung dari HP Anda.
- **📈 Advanced Trading Logic**: 
  - **Trailing Stop Loss**: Mengunci profit saat harga naik.
  - **Dynamic Slippage**: Menyesuaikan dengan volatilitas pasar.
  - **Parallel Processing**: Memproses banyak koin sekaligus tanpa antri.
- **🌐 Network Resilience**: Menggunakan **Axios** dan **DNS-over-HTTPS** untuk menembus blokir ISP dan gangguan DNS.

---

## 🛠️ Tech Stack

- **Backend**: NestJS (Node.js framework)
- **Database**: PostgreSQL with Prisma ORM
- **Blockchain**: Solana Web3.js & Jupiter V6 API
- **Deployment**: Docker, CapRover, GitHub Actions

---

## 📦 Instalasi & Setup

### 1. Kloning Repo
```bash
git clone <your-repo-url>
cd solana-automation
```

### 2. Install Dependencies
```bash
yarn install
```

### 3. Konfigurasi Environment
Buat file `.env` dan lengkapi datanya:
```env
PRIVATE_KEY="your_base58_private_key"
RPC_ENDPOINT="https://api.mainnet-beta.solana.com"
WSS_ENDPOINT="wss://api.mainnet-beta.solana.com"
TELEGRAM_BOT_TOKEN="your_bot_token"
TELEGRAM_CHAT_ID="your_chat_id"
```

### 4. Database Setup
```bash
npx prisma migrate dev
```

### 5. Jalankan Bot
```bash
yarn start:dev
```

---

## 🚢 Deployment (VPS / CapRover)

Bot ini sudah dilengkapi dengan **GitHub Actions** untuk deployment otomatis ke VPS via CapRover.
- Push kode ke branch `production`.
- Pastikan Secrets `CAPROVER_TOKEN` sudah disetting di GitHub.

---

## 🤖 Perintah Telegram

- `/status` - Cek status bot dan daftar trading yang sedang terbuka.
- `/balance` - Cek saldo SOL di wallet bot.

---

## ⚠️ Disclaimer
Trading koin micin di Solana berisiko tinggi. Gunakan dana dingin dan selalu pantau performa bot Anda. Bot ini hanya alat bantu, keputusan trading tetap di tangan Anda.

---
**Author**: Antigravity AI Assistant for [User Name]
**License**: MIT
