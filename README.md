# 🤖 Solana Sniper & Trend Hunter Bot (Predator Edition)

Bot trading Solana otomatis yang didesain untuk kecepatan tinggi, keamanan maksimal, dan strategi trading yang cerdas. Tidak hanya sekadar "nyerok" koin baru, bot ini mencari koin yang beneran rame (**Trending**).

---

## 🚀 Fitur Utama (Current Capabilities)

### 1. 🔍 Multi-Platform Real-time Scanner
- **Pump.fun Sniper**: Mendeteksi koin baru lahir via PumpPortal WebSocket.
- **Raydium WSS Scanner**: Mendeteksi pool baru di Raydium secara instan.
- **DexScreener Fallback**: Polling otomatis untuk menangkap token profil terbaru.

### 2. 💎 Smart Diamond Hands (Intelligent Exit)
- **Smart Stop Loss**: Tidak akan panik jual jika koin sedang minus tapi **Buy Pressure** masih tinggi (Hold for Rebound).
- **Dynamic Trailing Stop**: Mengunci profit secara otomatis saat harga naik, memberikan ruang koin untuk terus terbang.
- **Configurable Risk**: Batas rugi (Stop Loss) bisa diatur fleksibel lewat `.env`.

### 3. 🔥 Trend Hunter Logic
- **Market Traction Check**: Hanya membeli koin yang memiliki **Volume, Likuiditas, dan Transaksi** yang valid dalam 5 menit terakhir.
- **Anti-Sepi Retry**: Memantau koin baru selama 3 menit pertama; jika meledak, bot langsung masuk. Jika sepi, bot akan mengabaikannya.

### 4. 🛡️ Infrastructure Hardening
- **Helius Private RPC**: Koneksi stabil dan cepat menggunakan Private RPC & WSS.
- **DNS Hardening**: Menggunakan fallback DoH (Cloudflare/Google) untuk menghindari blokir ISP pada API Jupiter/RugCheck.
- **IPv4 Force**: Dioptimalkan untuk kestabilan koneksi di VPS.

### 5. 📊 Real-time Reporting & Analytics
- **Telegram Alerts**: Laporan instan via Telegram lengkap dengan simbol token, harga entry, harga exit, dan persentase profit/loss (PnL).
- **Trade History**: Menyimpan data perdagangan lengkap (termasuk simbol dan exit price) ke database PostgreSQL.

---

## 🛠️ Tech Stack
- **Framework**: NestJS (Node.js)
- **Database**: Prisma ORM with PostgreSQL
- **Blockchain**: Solana Web3.js (@solana/web3.js)
- **DEX Integration**: Jupiter V6 API, PumpPortal, DexScreener, RugCheck.
- **Deployment**: CapRover / Docker

---

## ⚙️ Cara Pakai Singkat
1. Konfigurasi `.env` (RPC, Wallet, Strategy).
2. `yarn build` & `npx prisma db push`.
3. `yarn start:dev` atau `yarn deploy:vps`.

---

## ⚠️ Disclaimer
Trading koin meme memiliki risiko sangat tinggi. Bot ini hanyalah alat bantu. Selalu gunakan **"Uang Dingin"** dan lakukan riset mandiri sebelum trading.

**Developed with ❤️ by Antigravity for Amirull** 🦾🚀
