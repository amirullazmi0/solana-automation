# 🦅 Solana Sniper & Scalper Bot v2.1

![Solana Sniper](https://img.shields.io/badge/Solana-Sniper-blueviolet?style=for-the-badge&logo=solana)
![Status](https://img.shields.io/badge/Status-Active-success?style=for-the-badge)
![Network](https://img.shields.io/badge/Network-Mainnet-orange?style=for-the-badge)
![Agent](https://img.shields.io/badge/Agent-Antigravity-blue?style=for-the-badge)

Bot Sniper Solana otomatis yang dirancang untuk kecepatan tinggi, keamanan maksimal, dan manajemen portofolio interaktif via Telegram. Bot ini memantau koin baru secara real-time dan melakukan eksekusi cerdas berdasarkan filter keamanan yang ketat.

---

## 🚀 Fitur Unggulan

### 🎯 Core Trading
- **Ultra-Fast Sniping**: Memantau koin baru (new pairs) langsung dari WebSocket **Pump.fun** dan pool **Raydium**.
- **Smart Execution**: Integrasi **Jupiter V6 API** untuk harga swap terbaik dan slippage yang dinamis.
- **Profit Management**: Fitur **Trailing Stop Loss** otomatis untuk mengunci profit maksimal saat harga terbang.

### 🛡️ Keamanan & Proteksi
- **3-Layer Security Filter**: Sistem filtrasi otomatis sebelum melakukan pembelian.
- **RugCheck API**: Validasi skor keamanan token untuk menghindari "Rug Pull".
- **Liquidity Analysis**: Verifikasi likuiditas via **DexScreener** (Minimal **$1.000 USD**) untuk memastikan pintu keluar (exit) yang aman.
- **Authority Check**: Memastikan Mint & Freeze Authority sudah dicabut oleh owner token.

### 🌐 Infrastruktur & Konektivitas (Resilience)
- **Anti-Blocking System**: Menggunakan jalur **IPv4 Forced** untuk stabilitas koneksi di VPS.
- **DNS Hardening**: Multi-layer resolution menggunakan **Hardcoded IP fallback** untuk Jupiter API dan **DNS-over-HTTPS (DoH)** via Cloudflare/Google.
- **Telegram Command Center**: Kontrol penuh via Telegram (`/status`, `/balance`) dan notifikasi real-time setiap ada transaksi.

### 🤖 AI Agent Integration
- **Antigravity Rules**: Menggunakan folder `.agents` untuk standarisasi kode (No `any` types, 4-space indentation).
- **Automated Commit**: Alur kerja Git otomatis berbasis context untuk menjaga riwayat pengembangan yang profesional.

---

## 🛠️ Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) (Node.js)
- **Database**: [PostgreSQL](https://www.postgresql.org/)
- **ORM**: [Prisma](https://www.prisma.io/)
- **Blockchain**: [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) & [Jupiter SDK](https://jup.ag/)
- **Deployment**: [Docker](https://www.docker.com/) & [CapRover](https://caprover.com/)

---

## 📦 Instalasi & Penggunaan

### 1. Persiapan Lokal
```bash
git clone <your-repo-url>
cd solana-automation
yarn install
```

### 2. Konfigurasi Environment
Buat file `.env` dan lengkapi datanya:
```env
DATABASE_URL="postgresql://user:pass@host:port/db"
PRIVATE_KEY="your_base58_private_key"
RPC_ENDPOINT="https://api.mainnet-beta.solana.com"
WSS_ENDPOINT="wss://api.mainnet-beta.solana.com"
TELEGRAM_BOT_TOKEN="your_bot_token"
TELEGRAM_CHAT_ID="your_chat_id"
```

### 3. Jalankan Bot
```bash
# Sinkronisasi database
npx prisma db push

# Jalankan mode development
yarn start:dev
```

---

## 🔄 Workflow Pengembangan

Gunakan perintah ini jika Anda menggunakan asisten AI Antigravity:
- **`/commit`** : Melakukan commit otomatis dengan pesan berbasis konteks per-kerjaan.
- **`yarn deploy:vps`** : Deploy otomatis ke server CapRover.

---

## 🤖 Perintah Telegram
- `/status` : Melihat daftar trade aktif, profit/loss berjalan, dan status bot.
- `/balance` : Cek saldo SOL pada wallet yang digunakan bot.

---

**Author**: Amirull Azmi & Antigravity (Google DeepMind)
**License**: MIT
