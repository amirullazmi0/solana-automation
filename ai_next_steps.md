# 🤖 AI Integration Roadmap - Solana Automation Bot

Dokumen ini menjelaskan rencana integrasi AI untuk meningkatkan profitabilitas (cuans) bot trading Solana kamu.

## 🎯 Objective
Mengganti filter statis (angka kaku) dengan keputusan berbasis konteks, narasi, dan sentimen sosial untuk menemukan koin "gem" sebelum meledak.

---

## 🛠 Phase 1: Foundation (The Brain Setup)
Sebelum AI bisa berpikir, kita harus kasih dia akses.

- [ ] **Setup AI Service**: Buat `src/ai/ai.service.ts` menggunakan SDK OpenAI atau LangChain.
- [ ] **Config API Keys**: Tambahkan `OPENAI_API_KEY` atau `GROQ_API_KEY` ke `.env`.
- [ ] **Cost Protection**: Implementasikan cache untuk hasil analisis AI agar tidak boros token API untuk koin yang sama.

## 🐦 Phase 2: Social Intelligence (Sentiment Radar)
Meme koin digerakkan oleh komunitas. AI akan menjadi mata kamu di Twitter/X.

- [ ] **Integrasi X/Twitter Scraper**: Ambil 20-50 tweet terbaru terkait `tokenMint`.
- [ ] **Scoring Engine**: AI menganalisis tweet tersebut untuk:
    - Membedakan "Organic Hype" vs "Bot Spam".
    - Mendeteksi keterlibatan influencer ternama (KOL).
    - Menilai kredibilitas Developer berdasarkan cara mereka berkomunikasi.
- [ ] **Conviction Score**: Bot hanya akan memberikan alert/eksekusi jika skor sentimen > 75/100.

## 🧠 Phase 3: Narrative Matching (Meta Detection)
AI menganalisis apakah koin baru ini mengikuti tren yang sedang "meta".

- [ ] **Market Context**: Beri AI data koin-koin yang naik 500% dalam 24 jam terakhir.
- [ ] **Matching Logic**: AI mencocokkan koin baru dengan meta tersebut.
    - *Contoh*: Meta saat ini adalah "AI Agents". Koin baru bertema "Meme AI" akan mendapat skor prioritas lebih tinggi.

## 🛡️ Phase 4: Behavioral Rug Detection
Mendeteksi penipuan yang lolos dari scan teknis biasa.

- [ ] **Pattern Recognition**: AI menganalisis urutan transaksi awal (deployment).
- [ ] **Red Flag Detector**: AI mencari pola "Wash Trading" atau "Fake Volume" yang sering digunakan penipu untuk menarik pembeli retail.

---

## 📈 Roadmap Eksekusi (Amirull's Guide)

1. **Minggu 1**: Implementasi `AIService` dan hubungkan ke ChatGPT/Llama.
2. **Minggu 2**: Tambahkan "AI Review" di setiap notifikasi Telegram (Hanya kasih saran dulu).
3. **Minggu 3**: Gunakan skor AI sebagai syarat utama di `ScannerService` sebelum melakukan **Auto-Buy**.

---

> [!TIP]
> Mulailah dengan **GPT-4o-mini**. Sangat murah, sangat cepat, dan cukup cerdas untuk sekadar menganalisis koin meme.
