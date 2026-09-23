# MaSoul Sniper — Bot Trading Memecoin Solana

Bot ini **membeli dan menjual memecoin Solana secara otomatis**, tanpa campur tangan manusia per
trade. Dia menemukan token yang baru lahir, menyaringnya lewat rantai pemeriksaan kuantitatif dan
keamanan, membeli lewat Jupiter kalau lolos semuanya, lalu memantau posisi itu sampai keluar sendiri
lewat take profit, trailing stop, stop loss, atau exit darurat saat mendeteksi rug.

Dikendalikan dari Telegram. Setiap chat punya wallet sendiri dan setelannya sendiri, jadi satu
instance bisa melayani beberapa akun sekaligus — sebagian live, sebagian dry run.

Strateginya **momentum jangka pendek**: mencari token yang volumenya sedang berakselerasi dengan
pembeli mendominasi penjual, masuk kecil, dan keluar cepat. Bukan strategi tahan lama. Umur token
yang dibeli dihitung dalam menit sampai jam, dan posisi biasanya ditutup dalam hitungan menit.

Dua jalur beli berjalan bersamaan:

- **Jalur utama** — token muda dari pump.fun dan feed DexScreener, diroute jadi `MICIN` (di bawah
  2 jam) atau `WHALE` (2 jam ke atas).
- **Jalur established** — token yang sudah matang dan sedang rebound atau mengalami community
  takeover.

Yang membuat bot ini rumit bukan keputusan belinya, tapi **jumlah cara sebuah token bisa ditolak**:
ada 84 alasan reject berbeda, dari likuiditas terlalu tipis sampai ekstensi Token-2022 yang
memungkinkan dev membekukan saldo pembeli. Dokumen ini menjelaskan mekanismenya dan fungsi setiap
knob konfigurasi.

**Peringatan:** ini perangkat lunak yang membelanjakan uang nyata pada aset yang sangat berisiko.
Bacalah [Rantai Gerbang](#rantai-gerbang) dan [Risk breaker](#risk-breaker) sebelum menyalakannya
dalam mode live.

---

## Daftar Isi

- [Cara Kerja](#cara-kerja)
- [Model Route](#model-route)
- [Rumus](#rumus)
- [Rantai Gerbang](#rantai-gerbang)
- [Katalog Alasan Reject](#katalog-alasan-reject)
- [Katalog Exit Reason](#katalog-exit-reason)
- [Referensi Konfigurasi](#referensi-konfigurasi)
- [Menjalankan](#menjalankan)

---

## Cara Kerja

```
PumpPortal WS  ─┐
DexScreener    ─┼─> ScannerService ──> AnalyzerService ──> TradeService ──> PriceMonitorService
boosts/profiles─┘   (discovery,        (rantai gerbang)    (Jupiter swap,   (trailing, stop,
Helius webhook ─┘    watchlist retry)                       fee/risk guard)  rug guard, exit)
                             │                                                      │
                             └──────────> ReportingService (alert Telegram) <────────┘
```

| Service | Tanggung jawab |
| --- | --- |
| `ScannerService` | Menemukan token, mengelola watchlist retry, memicu analisis, heartbeat |
| `AnalyzerService` | Rantai gerbang MICIN/WHALE, RugCheck, keamanan mint, konfirmasi entry |
| `EstablishedAnalyzerService` | Jalur beli kedua: rebound dan CTO untuk token matang |
| `TradeService` | Eksekusi swap Jupiter, capital/fee guard, risk breaker, penutupan trade |
| `PriceMonitorService` | Memantau posisi terbuka, trailing, stop loss, rug/dump guard |
| `ReportingService` | Alert Telegram, ringkasan harian, perintah manual |
| `AIService` | Advisory: penyesuaian trailing, kesehatan token, exit advisor |

---

## Model Route

Tidak ada `BOT_MODE`. Semua token masuk satu pipeline, route ditentukan dari umur:

| Route | Umur | Fokus |
| --- | --- | --- |
| `MICIN_ROUTE` | < 2 jam | Velocity, z-score, volume surge, anti-noise fake pump |
| `WHALE_ROUTE` | >= 2 jam | Momentum tervalidasi, social footprint, CTO, whale signal score |

Banyak knob punya varian per-route. Yang spesifik menang atas yang global — misalnya
`MICIN_STOP_LOSS_PERCENT` (8) dipakai untuk MICIN, bukan `STOP_LOSS_PERCENT` (12).

---

## Rumus

Dihitung di `checkMarketTraction` (`src/analyzer/analyzer.service.ts`):

```text
buckets        = clamp(umurToken_menit / 5, 1, 12)
avgVolume_5m   = volume_1h / buckets
volumeSurge    = volume_5m / avgVolume_5m
zScore         = (volume_5m - avgVolume_5m) / (avgVolume_5m x 0.5)

confidenceScore = buys_5m / (buys_5m + sells_5m)
vlRatio         = volume_5m / liquidity
volScore        = vlRatio x confidenceScore
velocity        = volume_5m / marketCap

buyShare_1h     = buys_1h / (buys_1h + sells_1h)
```

**Kenapa baselinenya dibagi bucket, bukan langsung 12.** Membagi dengan 12 mengasumsikan token
punya riwayat satu jam penuh. Untuk token yang lebih muda, angka 1 jam DexScreener **adalah** angka
5 menitnya, sehingga volumenya saling menghapus dan kedua metrik runtuh jadi konstanta:

```text
volumeSurge = v / (v/12)          = 12,00  untuk v berapa pun
zScore      = (v - v/12) / (v/24) = 22,00  untuk v berapa pun
```

Itu terlihat di produksi: enam token berbeda dalam satu batch alert melaporkan persis
`Surge: 12.00x` dan `Z: 22.00`. Keduanya maksimum matematis, bukan pengukuran — untuk token baru,
keduanya hanya mengatakan "umurnya di bawah 5 menit". Membagi dengan bucket yang benar-benar sudah
berlalu memperbaikinya, dan token berumur >= 1 jam berperilaku persis seperti sebelumnya.

Perhatikan juga `zScore` memakai asumsi standar deviasi = 0,5 x rata-rata, bukan stddev sebenarnya.
Ini pseudo z-score; berguna sebagai peringkat relatif, bukan sebagai ukuran statistik.

---

## Rantai Gerbang

Urutan sesungguhnya di `checkMarketTraction`. Gerbang murah dulu, yang mahal paling akhir.

| # | Gerbang | Alasan reject | Knob |
| --- | --- | --- | --- |
| 1 | Likuiditas nol / bonding curve | `zero_liquidity` | hard floor $1000 |
| 2 | Likuiditas minimum | `low_metrics` | `MIN_LIQUIDITY_USD` |
| 3 | Volume 5m minimum | `low_metrics` | `MIN_VOLUME_USD` |
| 4 | Jumlah pembeli minimum | `low_metrics` | `MIN_BUY_COUNT` |
| 5 | Batas market cap | `mcap_too_low` / `mcap_too_high` | `MIN_MCAP`, `MAX_MCAP` |
| 6 | Batas umur | `too_young` / `too_old` | `MIN_AGE_HOURS`, `MAX_AGE_HOURS` |
| 7 | Volume surge | `low_surge` | `ANALYZER_MIN_VOLUME_SURGE` |
| 8 | Tren bearish / rebound | `bearish_trend` | `BEARISH_REBOUND_1H_FLOOR_PCT`, `BEARISH_REBOUND_MIN_5M_PCT` |
| 9 | Rasio volume/likuiditas | `low_vl_ratio` | `MIN_VL_RATIO` |
| 10 | Keyakinan pembeli 5m | `low_buy_confidence` | `MIN_BUY_CONFIDENCE` |
| 11 | **Dominasi pembeli 1 jam** | `low_h1_buyer_dominance` | `MIN_H1_BUY_SHARE` |
| 12 | Dominasi pembeli 5m | `low_buyer_dominance` | `BUY_SELL_RATIO_THRESHOLD` |
| 13 | Momentum jangka pendek | `negative_short_term_momentum` | `MIN_PRICE_CHANGE_5M_PCT` |
| 14 | Velocity | `low_velocity` | `MIN_VOLUME_MCAP_RATIO` |
| 15 | **Volume beli/jual 1 jam (Helius)** | `low_h1_buy_volume` | `ENABLE_H1_FLOW_VOLUME`, `MIN_H1_BUY_VOLUME_SHARE` |

Setelah rantai ini lulus, `isTokenSafeToBuy` menjalankan lapis berikutnya: keamanan mint dan
Token-2022, RugCheck (LP lock, skor ternormalisasi, konsentrasi holder), profil creator, cap
chase harga MICIN (`MICIN_MAX_PRICE_CHANGE_5M`, `MICIN_MAX_PRICE_CHANGE_1H`), signal floor, lalu
konfirmasi entry.

Gerbang #15 sengaja terakhir: itu satu-satunya yang butuh panggilan API eksternal, jadi hanya
dijalankan untuk token yang sudah lolos semua pemeriksaan murah.

**Defaultnya mati** (`ENABLE_H1_FLOW_VOLUME`). Klasifikasi swap-nya terbukti benar — cocok dengan
pemisahan beli/jual per jam milik DexScreener, sebagian persis identik — tapi butuh 0,9–11,8 detik
per token, terlalu lambat untuk jalur entry yang harganya sudah bergerak sekitar 10% antara sinyal
dan quote. Nyalakan hanya kalau latensi sebesar itu bisa diterima.

---

## Katalog Alasan Reject

Muncul di log produksi dan alert Telegram. Kolom knob menunjukkan setelan mana yang mengubahnya.

### Metrik pasar (`AnalyzerService`)

| Alasan | Arti | Knob |
| --- | --- | --- |
| `no_dex_pair` | DexScreener belum mengindeks pair mana pun | `NO_DEX_PAIR_MAX_RETRIES` |
| `zero_liquidity` | Likuiditas < $1000, atau masih bonding curve pump.fun | `ZERO_LIQUIDITY_MAX_RETRIES` |
| `low_metrics` | Likuiditas, volume 5m, atau jumlah pembeli di bawah minimum | `MIN_LIQUIDITY_USD`, `MIN_VOLUME_USD`, `MIN_BUY_COUNT` |
| `mcap_too_low` / `mcap_too_high` | Market cap di luar rentang | `MIN_MCAP`, `MAX_MCAP` |
| `too_young` / `too_old` | Umur token di luar rentang | `MIN_AGE_HOURS`, `MAX_AGE_HOURS` |
| `low_surge` | Volume 5m tidak melampaui laju rata-rata 1 jam | `ANALYZER_MIN_VOLUME_SURGE` |
| `bearish_trend` | Harga 1 jam turun dan rebound 5m belum cukup | `BEARISH_REBOUND_1H_FLOOR_PCT`, `BEARISH_REBOUND_MIN_5M_PCT` |
| `low_vl_ratio` | Volume terlalu kecil dibanding likuiditas | `MIN_VL_RATIO` |
| `low_vol_score` | volScore di bawah ambang | `ANALYZER_MIN_VOL_SCORE` |
| `low_buy_confidence` | Pangsa pembeli 5m terlalu rendah | `MIN_BUY_CONFIDENCE` |
| `low_h1_buyer_dominance` | Pangsa transaksi beli 1 jam di bawah ambang | `MIN_H1_BUY_SHARE` |
| `low_buyer_dominance` | Beli 5m tidak cukup mendominasi jual | `BUY_SELL_RATIO_THRESHOLD` |
| `negative_short_term_momentum` | Harga 5m turun melewati batas | `MIN_PRICE_CHANGE_5M_PCT` |
| `low_velocity` | Volume kecil dibanding market cap | `MIN_VOLUME_MCAP_RATIO` |
| `low_h1_buy_volume` | Pangsa volume beli 1 jam di bawah ambang | `MIN_H1_BUY_VOLUME_SHARE` |
| `flow_volume_unavailable` | Helius gagal dan fail-open dimatikan | `FLOW_VOLUME_FAIL_OPEN` |
| `noisy_pump` | Lonjakan 5m vertikal tanpa dukungan 15m/1h | `MICIN_SIGNAL_SCORE_FLOOR` |
| `micin_price_chase` | Harga 5m sudah terbang terlalu jauh | `MICIN_MAX_PRICE_CHANGE_5M` |
| `micin_overextended_1h` | Harga 1 jam sudah terbang terlalu jauh | `MICIN_MAX_PRICE_CHANGE_1H` |
| `micin_signal_too_weak` | Whale signal score MICIN di bawah floor | `MICIN_SIGNAL_SCORE_FLOOR` |
| `whale_signal_too_weak` | Whale signal score WHALE di bawah floor | `WHALE_SIGNAL_SCORE_FLOOR` |
| `stagnant_timeout` | Token dipantau terlalu lama tanpa lolos | `ANALYZER_MAX_SCAN_DURATION_MIN` |
| `ai_rejected` | Lapis keputusan AI mengembalikan skip | `ENABLE_AI_ENTRY_DECISION`, `AI_CONVICTION_THRESHOLD` |
| `narrative_weak` | AI menilai nama dan jejak sosial token sebagai template spam | `ENABLE_AI_NARRATIVE_GATE`, `NARRATIVE_MIN_CONFIDENCE` |
| `meta_cold` | Meta token ini terbukti rugi pada jendela yang diukur | `ENABLE_META_GATE`, `META_MIN_TRADE_SAMPLE` |

Selama `ENABLE_AI_NARRATIVE_GATE` mati, verdict tetap dihitung dan dicatat sebagai
`narrative_shadow` di log — lengkap dengan `wouldReject` — tapi tidak pernah menggugurkan kandidat.
Itulah keluaran periode shadow, dan satu-satunya dasar untuk memutuskan apakah gerbangnya layak
dinyalakan.
| `error` | Pengecualian tak terduga di rantai gerbang | — |

### Keamanan dan RugCheck

| Alasan | Arti | Knob |
| --- | --- | --- |
| `mint_authority_active` | Mint authority belum dicabut, supply bisa ditambah | — (hard reject) |
| `freeze_authority_active` | Freeze authority aktif, saldo bisa dibekukan | — (hard reject) |
| `token_2022_non_transferable` | Ekstensi Token-2022 melarang transfer | — (hard reject) |
| `token_2022_default_frozen` | Akun baru default beku | — (hard reject) |
| `token_2022_transfer_hook` | Ada transfer hook, transfer bisa diblokir sewaktu-waktu | — (hard reject) |
| `token_2022_permanent_delegate` | Delegate permanen bisa memindahkan token siapa pun | — (hard reject) |
| `token_2022_mutable_transfer_fee` | Transfer fee bisa diubah setelah beli | `MAX_TOKEN_TRANSFER_FEE_BPS` |
| `token_extension_parse_failed` | Ekstensi mint tidak bisa dibaca | — |
| `safety_rpc_failed` | RPC gagal saat memeriksa mint | — |
| `lp_not_burned` | LP tidak burned dan persen lock di bawah ambang | `MIN_LP_LOCKED_PCT` |
| `lp_status_unavailable` | RugCheck tidak melaporkan status LP | `MIN_LP_LOCKED_PCT` |
| `high_risk_score` | Skor risiko ternormalisasi RugCheck terlalu tinggi | `RUGCHECK_MAX_NORMALISED_SCORE` |
| `danger_risks_detected` | RugCheck menandai risiko level danger | — |
| `high_concentration` | Konsentrasi holder melewati batas | `MAX_SINGLE_HOLDER_PCT`, `MAX_TOP5_HOLDER_PCT`, `MAX_TOP10_HOLDER_PCT` |
| `honeypot_detected` | Simulasi jual gagal, token tidak bisa dijual | `ENABLE_PREBUY_SELLABILITY_GUARD` |
| `rugcheck_no_data` / `rugcheck_error` | RugCheck tidak menjawab | `RUGCHECK_MIN_SAFETY_INDEX` |
| `creator_high_risk` | Creator masuk blacklist atau riskScore >= 80 | — |
| `creator_holds_too_much` | Creator masih memegang terlalu banyak supply | `MAX_CREATOR_HOLD_PCT_FOR_BUY` |
| `creator_not_zero` | Saldo creator belum nol padahal disyaratkan | `REQUIRE_DEV_ZERO_BALANCE` |
| `creator_data_unavailable` | Profil creator tidak bisa dievaluasi | — |

### Konfirmasi entry (`ScannerService`)

Dijalankan setelah semua gerbang lulus, sesaat sebelum swap.

| Alasan | Arti | Knob |
| --- | --- | --- |
| `entry_confirmation_pending` | Jendela konfirmasi masih berjalan | `ENTRY_CONFIRMATION_WINDOW_MS` |
| `entry_confirmation_price_chase` | Harga kabur naik selama konfirmasi | `ENTRY_CONFIRMATION_MAX_CHASE_PCT`, `MAX_BUY_CHASE_PCT` |
| `entry_confirmation_price_drop` | Harga jatuh selama konfirmasi | `ENTRY_CONFIRMATION_MAX_DROP_PCT` |
| `entry_confirmation_liquidity_drop` | Likuiditas menyusut selama konfirmasi | `ENTRY_CONFIRMATION_MIN_LIQUIDITY_RATIO` |
| `entry_confirmation_buyers_weak` | Aliran pembeli baru tidak cukup | `ENTRY_CONFIRMATION_MIN_NEW_BUYS`, `ENTRY_CONFIRMATION_BUY_SELL_RATIO` |
| `entry_confirmation_window_reset` | Sinyal kedaluwarsa, jendela dimulai ulang | `MAX_BUY_SIGNAL_AGE_MS` |
| `entry_confirmation_passed` | Bukan reject — status lulus konfirmasi, swap dilanjutkan | — |

### Guard modal dan risiko (`TradeService`)

| Alasan | Arti | Knob |
| --- | --- | --- |
| `fee_floor_guard` | Posisi terlalu kecil, fee memakan porsi tak masuk akal | `MIN_EXECUTABLE_POSITION_USD`, `ESTIMATED_ROUNDTRIP_FEE_SOL`, `MAX_ESTIMATED_ROUNDTRIP_FEE_PCT` |
| `capital_guard` | Modal terpakai sudah melewati batas | `TOTAL_CAPITAL`, `MAX_POSITION_USD`, `MAX_POSITION_WALLET_PCT` |
| `balance_guard` | Saldo wallet on-chain tidak cukup | `MIN_RESERVE_USD`, `MAX_RESERVE_USD` |
| `slot_guard` | Semua slot posisi sedang terpakai | `TOTAL_SLOTS` |
| `already_open_trade` | Sudah ada posisi terbuka untuk token ini | — |
| `max_consecutive_losses` | Risk breaker: rugi berurutan | `MICIN_MAX_CONSECUTIVE_LOSSES`, `WHALE_MAX_CONSECUTIVE_LOSSES` |
| `daily_max_loss` | Rugi harian melewati batas | `DAILY_MAX_LOSS_USD` |
| `max_drawdown` | Drawdown melewati batas | `MAX_DRAWDOWN_PCT` |
| `cooldown` | Masih dalam cooldown setelah trade sebelumnya | `COOLDOWN_WIN_HOURS`, `COOLDOWN_LOSS_HOURS` |
| `disabled_until` | Pembelian dimatikan manual sampai waktu tertentu | `DISABLE_BUY_UNTIL` |
| `invalid_price_or_amount` | Harga atau jumlah tidak masuk akal | `TRADE_DUST_THRESHOLD` |
| `honeypot_probe_failed` / `honeypot_probe_error` | Probe beli-jual nyata gagal | `ENABLE_HONEYPOT_LIVE_PROBE`, `HONEYPOT_PROBE_USD` |
| `probe_buy_sell_confirmed` | Bukan reject — probe berhasil menjual kembali, token terbukti bisa dijual | `HONEYPOT_PROBE_CACHE_HOURS` |

### Retry versus terminal, dan satu label mati

Dua mekanisme berbeda yang mudah tertukar:

- **Flag `permanent`** pada hasil reject menentukan apakah token boleh dianalisis ulang. Gerbang
  umur, market cap, dan keamanan mint menyetelnya `true`; sebagian besar gerbang metrik tidak.
- **Kelayakan radar watchlist** adalah daftar terpisah dan sangat pendek — hanya `low_surge`,
  `low_vol_score`, dan `whale_signal_too_weak` yang benar-benar dipantau ulang
  (`scanner.service.ts:157-165`).

`no_volume_anomaly` masih tercantum di daftar itu dan di switch pelabelan
`reporting.service.ts:1636`, tapi **tidak pernah dihasilkan oleh apa pun**. Gerbang z-score yang
dulu memproduksinya sudah dihapus, dan `ANALYZER_MIN_Z_SCORE` tidak lagi ada di `config.json` —
`zScore` sekarang hanya dihitung untuk pelaporan dan payload AI, bukan sebagai gerbang.

Beberapa alasan juga bersifat templat, jadi tidak akan cocok persis dengan tabel di atas:
`rugcheck_api_error: <msg>`, `established_rugcheck_failed_<sub>`, `token_2022_transfer_fee_too_high:<bps>`,
`price_miss_x<n>`, `buy_broadcast_unconfirmed: <err>`, `stop_loss_stuck_open_x<n>`,
`cooldown_win` / `cooldown_loss`, dan `scale_in_race_closed: <id>`.

### Jalur established (rebound / CTO)

Alasan berawalan `established_*` adalah padanan dari lapis keamanan di atas, dipakai
`EstablishedAnalyzerService` dengan ambang jalurnya sendiri:

| Alasan | Padanan di jalur utama |
| --- | --- |
| `established_security_authority_failed` | `mint_authority_active` / `freeze_authority_active` |
| `established_high_risk_score` | `high_risk_score` |
| `established_danger_risks_detected` | `danger_risks_detected` |
| `established_high_concentration` | `high_concentration` |
| `established_honeypot_detected` | `honeypot_detected` |
| `established_creator_high_risk` | `creator_high_risk` |
| `established_creator_holds_too_much` | `creator_holds_too_much` |
| `established_creator_not_zero` | `creator_not_zero` |
| `no_rugcheck_data` | `rugcheck_no_data` |

Yang khas jalur ini:

| Alasan | Arti | Knob |
| --- | --- | --- |
| `too_young_for_rebound` / `too_old_for_rebound` | Umur di luar jendela established | `ESTABLISHED_MIN_AGE_HOURS`, `ESTABLISHED_MAX_AGE_HOURS` |
| `low_established_liquidity` | Likuiditas di bawah minimum jalur ini | `MIN_ESTABLISHED_LIQUIDITY` |
| `mcap_too_high_for_established` | Market cap terlalu besar untuk rebound | `MAX_ESTABLISHED_MCAP` |
| `rebound_not_triggered` | Pola rebound belum terpenuhi | `REBOUND_PRICE_DROP_PCT`, `VOLUME_SPIKE_RATIO` |
| `lp_not_burned_or_locked` | LP tidak burned maupun locked | `MIN_LP_LOCKED_PCT` |
| `signal_only` | Lolos tapi chat dalam mode dry run | per-chat `dryRun` |

---

## Katalog Exit Reason

Tersimpan di `Trade.exitReason`, muncul di alert jual.

| Exit reason | Arti | Knob |
| --- | --- | --- |
| `TAKE_PROFIT` | Target profit tercapai | `MICIN_TAKE_PROFIT_PERCENT`, `WHALE_TAKE_PROFIT_PERCENT` |
| `TRAILING_STOP` | Trailing stop tersentuh setelah aktif | `MICIN_TRAILING_ACTIVATION_PERCENT`, `MICIN_TRAILING_DISTANCE_PERCENT` |
| `PARTIAL_TAKE_PROFIT` | Jual sebagian (50%) untuk mengunci profit | `MIN_TRAILING_DISTANCE_BEFORE_PARTIAL_PERCENT` |
| `STOP_LOSS` | Lantai stop loss ditembus | `MICIN_STOP_LOSS_PERCENT`, `WHALE_STOP_LOSS_PERCENT` |
| `STOP_LOSS_ZONE_TIMEOUT` | Terlalu lama berada di zona stop tanpa pulih | `ENABLE_DYNAMIC_HOLD_ZONE`, `DYNAMIC_HOLD_ZONE_MAX_SECONDS` |
| `LIQUIDITY_RUGPULL` | Likuiditas ditarik | `ENABLE_LIQUIDITY_RUG_GUARD`, `LIQUIDITY_DROP_EXIT_PERCENT` |
| `RUGPULL` | Pola rug terdeteksi | `LIQUIDITY_DROP_PANIC_PERCENT` |
| `DEV_DUMP` | Creator membuang kepemilikannya | `DEV_DUMP_THRESHOLD_PERCENT` |
| `WHALE_DUMP` | Whale membuang, tekanan jual mendominasi | `ENABLE_WHALE_DUMP_EXIT`, `WHALE_DUMP_THRESHOLD_PERCENT` |
| `PANIC_SELL` | Keluar darurat | `LIQUIDITY_DROP_PANIC_PERCENT` |
| `AI_HEALTH_CRITICAL` | Pemeriksaan kesehatan AI menilai kritis | `HEALTH_CHECK_BEFORE_EARLY_SL` |
| `AI_STOP_LOSS_CONFIRMED` | AI mengkonfirmasi stop loss setelah pembelaan | `ENABLE_AI_CUTLOSS_DEFENSE` |
| `AI_EXIT_ADVISOR` | AI exit advisor memerintahkan keluar | `AI_EXIT_ADVISOR_ALLOW_EXIT_NOW` |
| `MANUAL_SELL` | Dijual manual lewat Telegram | — |

### Dua klasifikasi perilaku

**Set darurat** melewati guard tahan-minimum sebelum exit (`price-monitor.service.ts:876-885`):
`PANIC_SELL`, `DEV_DUMP`, `RUGPULL`, `LIQUIDITY_RUGPULL`, `WHALE_DUMP`, `AI_HEALTH_CRITICAL`.

**Set slippage darurat** memaksa 1500 bps dan priority fee tinggi, ditentukan oleh
`isUrgentExitReason()` di `trade.service.ts`: `STOP_LOSS`, `STOP_LOSS_ZONE_TIMEOUT`,
`TRAILING_STOP`, `DEV_DUMP`, `RUGPULL`, `LIQUIDITY_RUGPULL`, `WHALE_DUMP`, `PANIC_SELL`,
`AI_HEALTH_CRITICAL`, `AI_STOP_LOSS_CONFIRMED`.

Set kedua sengaja **lebih luas** dari set pertama. `LIQUIDITY_RUGPULL` dan `WHALE_DUMP` dulu
tergolong darurat bagi price monitor tapi dijual dengan slippage biasa — padahal justru di situ
gagal terisi paling mahal, karena pool sedang dikuras. `AI_STOP_LOSS_CONFIRMED` juga masuk, karena
itu memang stop loss.

`AI_EXIT_ADVISOR` **tidak** masuk, dan itu disengaja: dia exit diskresioner yang bisa menyala saat
posisi nyaris tidak bergerak, jadi memberinya slippage 15% berarti membiarkan saran berubah menjadi
kerugian besar. Exit sukarela (`TAKE_PROFIT`, `PARTIAL_TAKE_PROFIT`, `MANUAL_SELL`) dikecualikan
dengan alasan yang sama — tidak ada yang sedang ambruk, jadi tidak ada alasan membayar mahal untuk
keluar.

**Pemicu blacklist creator otomatis**: `DEV_DUMP`, `RUGPULL`, `LIQUIDITY_RUGPULL`
(`trade.service.ts:2966-2999`).

Catatan dari data produksi: `AI_STOP_LOSS_CONFIRMED` menunda jual dan hasilnya 0 menang dari 4
(-$4,03 gross, rata-rata -$1,01 vs -$0,52 untuk kekalahan lain). `AI_HEALTH_CRITICAL` keluar lebih
awal dan hasilnya 3 menang dari 4 (+$0,47). AI yang mempercepat exit membantu; AI yang menunda exit
mahal.

---

---

## Referensi Konfigurasi

Semua nilai perilaku ada di `config.json`, dibaca lewat `loadRuntimeConfig()` ke `ConfigService`.
Kredensial ada di `.env`, bukan di sini.

**`config.json` dibaca relatif terhadap direktori kerja.** `parseRuntimeConfig()` memanggil
`resolve(process.cwd(), 'config.json')`, dan bila berkasnya tidak ditemukan fungsinya **diam-diam**
mengembalikan `{}` — setiap knob lalu jatuh ke default hardcoded di kode, yang nilainya jauh berbeda:

| Knob | `config.json` | Default kode |
| --- | --- | --- |
| `MIN_LIQUIDITY_USD` | 15000 | 7500 |
| `MIN_VOLUME_USD` | 6 | 200 |
| `MAX_MCAP` | 50000000 | 300000 |
| `TRAILING_DISTANCE_PERCENT` | 0.8 | 5.0 |
| `COOLDOWN_LOSS_HOURS` | 1 | 24 |

Tidak ada peringatan di log. Bot akan tampak jalan normal sambil memakai strategi yang sama sekali
lain. Selalu jalankan dari root repo.

Saat boot, `validateConfig()` memeriksa ~22 invarian dan menolak konfigurasi yang tidak konsisten:
urutan batas holder (single <= top5 <= top10), urutan ambang likuiditas (WARN <= EXIT <= PANIC),
pangsa yang harus berada di rentang 0–1, dan kecukupan modal
(`TOTAL_CAPITAL - RESERVE_AMOUNT >= POSITION_SIZE_USD * TOTAL_SLOTS`).

Knob berawalan `MICIN_` atau `WHALE_` **menang** atas versi globalnya. Misalnya
`MICIN_STOP_LOSS_PERCENT` yang dipakai untuk route MICIN, bukan `STOP_LOSS_PERCENT`.

### Modal dan ukuran posisi

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `TOTAL_CAPITAL` | 16 | Modal total yang dianggap tersedia (USD) |
| `RESERVE_AMOUNT` | 2 | Cadangan dasar |
| `DYNAMIC_RESERVE_RATIO` | 0.05 | Cadangan dinamis sebagai rasio saldo |
| `MIN_RESERVE_USD` | 2 | Batas bawah cadangan |
| `MAX_RESERVE_USD` | 2 | Batas atas cadangan |
| `TOTAL_SLOTS` | 2 | Posisi terbuka bersamaan |
| `POSITION_SIZE_USD` | 5 | Ukuran posisi dasar |
| `MICIN_POSITION_SIZE_MULTIPLIER` | 1 | Pengali untuk MICIN |
| `WHALE_POSITION_SIZE_MULTIPLIER` | 1.1 | Pengali untuk WHALE |
| `MAX_POSITION_USD` | 10 | Batas keras per posisi |
| `MAX_POSITION_WALLET_PCT` | 70 | Batas posisi sebagai persen saldo terpakai |
| `MIN_EXECUTABLE_POSITION_USD` | 2 | Di bawah ini, `fee_floor_guard` menolak |
| `ESTIMATED_ROUNDTRIP_FEE_SOL` | 0.0013 | Perkiraan fee bolak-balik |
| `MAX_ESTIMATED_ROUNDTRIP_FEE_PCT` | 5 | Porsi maksimum fee terhadap posisi |
| `TRADE_FEE_CUSHION_SOL` | 0.005 | Bantalan SOL untuk fee jaringan |
| `TRADE_DUST_THRESHOLD` | 0.000001 | Ambang debu |

### Exit, trailing, dan take profit

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `TAKE_PROFIT_PERCENT` | 20 | Target profit global |
| `MICIN_TAKE_PROFIT_PERCENT` | 25 | Target profit MICIN |
| `WHALE_TAKE_PROFIT_PERCENT` | 22 | Target profit WHALE |
| `STOP_LOSS_PERCENT` | 12 | Stop loss global |
| `MICIN_STOP_LOSS_PERCENT` | 8 | Stop loss MICIN |
| `WHALE_STOP_LOSS_PERCENT` | 10 | Stop loss WHALE |
| `TRAILING_DISTANCE_PERCENT` | 0.8 | Jarak trailing global |
| `MICIN_TRAILING_ACTIVATION_PERCENT` | 10 | Trailing MICIN baru aktif di +10% |
| `WHALE_TRAILING_ACTIVATION_PERCENT` | 10 | Trailing WHALE baru aktif di +10% |
| `MICIN_TRAILING_DISTANCE_PERCENT` | 4 | Jarak trailing MICIN |
| `WHALE_TRAILING_DISTANCE_PERCENT` | 3 | Jarak trailing WHALE |
| `RUNNER_TRAILING_DISTANCE_MULTIPLIER` | 1.5 | Pelebaran trailing untuk runner |
| `RUNNER_BREAKEVEN_FLOOR_PERCENT` | 4 | Lantai breakeven runner |
| `MIN_TRAILING_DISTANCE_BEFORE_PARTIAL_PERCENT` | 3 | Syarat sebelum partial TP |
| `MIN_NET_EXIT_PROFIT_PERCENT` | 2 | Profit bersih minimum untuk exit sukarela |
| `ESTIMATED_SELL_NETWORK_FEE_SOL` | 0.0005 | Perkiraan fee jual |
| `DEX_FEE_ROUNDTRIP_PERCENT` | 1 | Perkiraan fee DEX bolak-balik |
| `DISABLE_SL_PATIENCE` | true | Matikan penundaan stop loss |
| `ENABLE_CONSERVATIVE_EXIT_GUARD` | false | Guard exit konservatif |
| `MIN_NON_CRITICAL_HOLD_SECONDS` | 20 | Tahan minimum untuk exit non-kritis |
| `STOP_LOSS_GUARD_DEPTH_FLOOR_PERCENT` | 30 | Lantai kedalaman guard stop loss |
| `STOP_LOSS_DEEP_DROP_MULTIPLIER` | 2 | Ambang "penurunan dalam" = 2x stop loss |
| `STOP_LOSS_DEEP_DROP_CONFIRM_MS` | 0 | Jeda konfirmasi penurunan dalam (0 = jual langsung) |
| `ENABLE_DYNAMIC_HOLD_ZONE` | false | Zona tahan dinamis di sekitar stop |
| `DYNAMIC_HOLD_ZONE_MAX_SECONDS` | 30 | Durasi maksimum zona tahan |

### Gerbang entry

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `MIN_LIQUIDITY_USD` | 15000 | Likuiditas minimum. Lever tunggal paling berdampak |
| `MIN_VOLUME_USD` | 6 | Volume 5m minimum (USD) |
| `MIN_BUY_COUNT` | 1 | Jumlah pembeli 5m minimum |
| `MIN_MCAP` | 2000 | Market cap minimum |
| `MAX_MCAP` | 50000000 | Market cap maksimum |
| `MIN_AGE_HOURS` | 0.005 | Umur minimum (~18 detik) |
| `MAX_AGE_HOURS` | 72 | Umur maksimum |
| `MIN_VL_RATIO` | 0.003 | volume_5m / likuiditas minimum |
| `MIN_VOLUME_MCAP_RATIO` | 0.004 | volume_5m / market cap minimum |
| `ANALYZER_MIN_VOL_SCORE` | 0.002 | volScore minimum |
| `ANALYZER_MIN_VOLUME_SURGE` | 0.5 | volumeSurge minimum |
| `MIN_BUY_CONFIDENCE` | 0.58 | Pangsa pembeli 5m minimum |
| `BUY_SELL_RATIO_THRESHOLD` | 1.35 | Rasio beli:jual 5m minimum |
| `MIN_H1_BUY_SHARE` | 0.6 | Pangsa transaksi beli 1 jam minimum (60/40) |
| `MIN_PRICE_CHANGE_5M_PCT` | -2 | Batas penurunan 5m |
| `BEARISH_REBOUND_1H_FLOOR_PCT` | -16 | Di bawah ini ditolak; menutup jalur dead-cat bounce |
| `BEARISH_REBOUND_MIN_5M_PCT` | 8 | Rebound 5m minimum bila 1h negatif |
| `MICIN_MAX_PRICE_CHANGE_5M` | 18 | Cap chase harga 5m |
| `MICIN_MAX_PRICE_CHANGE_1H` | 45 | Cap chase harga 1 jam |
| `MICIN_SIGNAL_SCORE_FLOOR` | 25 | Signal floor MICIN |
| `WHALE_SIGNAL_SCORE_FLOOR` | 8 | Signal floor WHALE |
| `MARKET_REGIME` | `bullish_gas` | Teks bebas yang diinterpolasi ke prompt AI. Hanya `bearish_chaos` yang dicabangkan di kode; nilai lain tidak punya arti struktural |

### Analisis aliran dana 1 jam (Helius)

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `ENABLE_H1_FLOW_VOLUME` | **false** | Saklar utama. Mati — lihat Keterbatasan |
| `MIN_H1_BUY_VOLUME_SHARE` | 0.55 | Pangsa volume beli 1 jam minimum |
| `HELIUS_FLOW_MAX_PAGES` | 3 | Batas paginasi (100 tx per halaman) |
| `HELIUS_FLOW_CACHE_TTL_MS` | 60000 | TTL cache per mint |
| `HELIUS_FLOW_MIN_DELAY_MS` | 250 | Jeda antar panggilan Helius |
| `FLOW_VOLUME_FAIL_OPEN` | true | Helius error tidak memblokir pembelian |

### Keamanan, RugCheck, dan holder

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `MIN_LP_LOCKED_PCT` | 90 | Persen LP terkunci minimum |
| `RUGCHECK_MAX_NORMALISED_SCORE` | 60 | Batas skor risiko ternormalisasi (0–100) |
| `RUGCHECK_MIN_SAFETY_INDEX` | 0.7 | Indeks keamanan minimum |
| `AGGRESSIVE_RUGCHECK_MIN_SAFETY_INDEX` | 0.6 | Versi longgar untuk token berlikuiditas tebal |
| `AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD` | 5000 | Likuiditas minimum untuk memakai tier longgar |
| `HOLDER_DATA_SETTLE_MINUTES` | 10 | Tunggu data holder RugCheck stabil sebelum reject permanen |
| `MAX_SINGLE_HOLDER_PCT` | 10 | Batas holder tunggal |
| `MAX_TOP5_HOLDER_PCT` | 22 | Batas top 5 |
| `MAX_TOP10_HOLDER_PCT` | 30 | Batas top 10 |
| `AGGRESSIVE_MAX_SINGLE_HOLDER_PCT` | 15 | Batas longgar holder tunggal |
| `AGGRESSIVE_MAX_TOP5_HOLDER_PCT` | 30 | Batas longgar top 5 |
| `AGGRESSIVE_MAX_TOP10_HOLDER_PCT` | 38 | Batas longgar top 10 |
| `MAX_CREATOR_HOLD_PCT_FOR_BUY` | 3 | Kepemilikan creator maksimum |
| `REQUIRE_DEV_ZERO_BALANCE` | false | Wajibkan saldo creator nol |
| `DEV_DUMP_THRESHOLD_PERCENT` | 10 | Ambang deteksi dev dump |
| `MAX_TOKEN_TRANSFER_FEE_BPS` | 300 | Transfer fee Token-2022 maksimum |

### Eksekusi swap

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `SLIPPAGE_BPS` | 350 | Slippage dasar |
| `MICIN_MAX_SLIPPAGE_BPS` | 700 | Slippage maksimum MICIN |
| `WHALE_MAX_SLIPPAGE_BPS` | 500 | Slippage maksimum WHALE |
| `MAX_PRICE_IMPACT_PCT` | 30 | Price impact maksimum global |
| `MICIN_MAX_PRICE_IMPACT_PCT` | 18 | Price impact maksimum MICIN |
| `WHALE_MAX_PRICE_IMPACT_PCT` | 7 | Price impact maksimum WHALE |
| `TRADE_TIMEOUT_MS` | 12000 | Timeout swap |
| `TRADE_MAX_RETRIES` | 6 | Percobaan ulang swap |
| `TRADE_PRIORITY_MULTIPLIER` | 6 | Pengali priority fee |
| `USE_JITO` | true | Kirim lewat Jito bundle |
| `JITO_TIP_SOL` | 0.0001 | Tip Jito |
| `JITO_MIN_POSITION_USD` | 5 | Posisi minimum untuk pakai Jito |
| `JITO_BLOCK_ENGINE_URL` | `https://mainnet.block-engine.jito.wtf/api/v1/bundles` | Endpoint bundle Jito |
| `ENABLE_PREBUY_SELLABILITY_GUARD` | true | Simulasi jual sebelum beli |
| `MAX_PREBUY_ROUNDTRIP_LOSS_PCT` | 12 | Rugi simulasi bolak-balik maksimum |
| `MICIN_MAX_PREBUY_ROUNDTRIP_LOSS_PCT` | 15 | Versi MICIN |
| `WHALE_MAX_PREBUY_ROUNDTRIP_LOSS_PCT` | 10 | Versi WHALE |
| `ENABLE_HONEYPOT_LIVE_PROBE` | true | Probe beli-jual nyata bernilai kecil |
| `HONEYPOT_PROBE_MIN_POSITION_USD` | 20 | Posisi minimum yang memicu probe |
| `HONEYPOT_PROBE_USD` | 0.5 | Nilai probe |
| `HONEYPOT_PROBE_CACHE_HOURS` | 24 | TTL cache hasil probe |

### Konfirmasi entry

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `ENTRY_CONFIRMATION_WINDOW_MS` | 3000 | Panjang jendela konfirmasi |
| `ENTRY_CONFIRMATION_MAX_CHASE_PCT` | 12 | Kenaikan harga maksimum selama konfirmasi |
| `ENTRY_CONFIRMATION_MAX_DROP_PCT` | 2.5 | Penurunan harga maksimum |
| `ENTRY_CONFIRMATION_MIN_LIQUIDITY_RATIO` | 0.92 | Likuiditas minimum relatif saat sinyal |
| `ENTRY_CONFIRMATION_MIN_NEW_BUYS` | 0 | Pembeli baru minimum |
| `ENTRY_CONFIRMATION_BUY_SELL_RATIO` | 1.1 | Rasio beli:jual selama konfirmasi |
| `MAX_BUY_CHASE_PCT` | 8 | Chase maksimum sinyal ke quote |
| `MAX_BUY_SIGNAL_AGE_MS` | 15000 | Umur sinyal maksimum |

### Risk breaker

Ketiga breaker membaca trade `CLOSED` bermode `LIVE` milik chat itu sendiri, dibandingkan terhadap
`updatedAt`. Yang membedakan hanya batas kiri jendelanya:

| Breaker | Batas kiri | Pulih sendiri |
| --- | --- | --- |
| `daily_max_loss` | `max(RISK_PNL_START_AT, awal hari UTC)` | tiap 00:00 UTC |
| `max_consecutive_losses` | `max(RISK_PNL_START_AT, now - RISK_CONSECUTIVE_LOOKBACK_HOURS)` | bergulir |
| `max_drawdown` | `max(RISK_PNL_START_AT, now - RISK_DRAWDOWN_LOOKBACK_HOURS)` | bergulir |

Tanpa `RISK_DRAWDOWN_LOOKBACK_HOURS`, drawdown adalah satu-satunya breaker tanpa jendela bergulir:
rentangnya hanya bisa membesar, dan selama ia memblokir pembelian tidak ada P&L baru yang bisa
mengangkat jumlahnya kembali. Itu mengunci permanen dan hanya bisa dilepas dengan mengedit
konfigurasi lalu **restart proses**.

Perlu diingat: mengosongkan `RISK_PNL_START_AT` membuat perhitungan memakai **seluruh riwayat**,
sehingga breaker menjadi lebih ketat, bukan lebih longgar. Jendela bergulirlah yang membatasinya.

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `DAILY_MAX_LOSS_USD` | 2.5 | Batas rugi harian |
| `MAX_CONSECUTIVE_LOSSES` | 2 | Rugi berurutan global |
| `MICIN_MAX_CONSECUTIVE_LOSSES` | 2 | Rugi berurutan MICIN |
| `WHALE_MAX_CONSECUTIVE_LOSSES` | 3 | Rugi berurutan WHALE |
| `MAX_DRAWDOWN_PCT` | 25 | Drawdown maksimum |
| `RISK_CONSECUTIVE_LOOKBACK_HOURS` | 2 | Jendela hitung rugi berurutan |
| `RISK_DRAWDOWN_LOOKBACK_HOURS` | 24 | Jendela bergulir untuk drawdown. `0` mematikannya dan kembali bergantung pada `RISK_PNL_START_AT` saja |
| `RISK_APPLY_TO_MANUAL` | false | Terapkan risk breaker ke trade manual |
| `RISK_PNL_START_AT` | `""` | Batas bawah opsional untuk seluruh perhitungan risiko. **Kosong berarti seluruh riwayat, bukan mati** |
| `DISABLE_BUY_UNTIL` | `""` | Matikan pembelian sampai waktu tertentu |
| `COOLDOWN_WIN_HOURS` | 0.15 | Cooldown setelah menang (~9 menit) |
| `COOLDOWN_LOSS_HOURS` | 1 | Cooldown setelah kalah |

### Rug dan dump guard

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `ENABLE_LIQUIDITY_RUG_GUARD` | true | Pantau penarikan likuiditas |
| `LIQUIDITY_DROP_WARN_PERCENT` | 25 | Ambang peringatan |
| `LIQUIDITY_DROP_EXIT_PERCENT` | 35 | Ambang keluar |
| `LIQUIDITY_DROP_PANIC_PERCENT` | 60 | Ambang panik |
| `LIQUIDITY_DROP_CONFIRM_TICKS` | 1 | Tick konfirmasi sebelum bertindak |
| `ENABLE_WHALE_DUMP_EXIT` | true | Keluar saat whale dump |
| `WHALE_DUMP_THRESHOLD_PERCENT` | 20 | Ambang whale dump |
| `WHALE_DUMP_PANIC_PERCENT` | 50 | Ambang panik whale dump |
| `WHALE_DUMP_SELL_BUY_RATIO` | 1.2 | Rasio jual:beli pemicu |
| `WHALE_DUMP_MIN_SELL_COUNT` | 5 | Jumlah jual minimum |
| `WHALE_DUMP_CONFIRM_TICKS` | 2 | Tick konfirmasi |

### Lapis AI

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Endpoint kompatibel OpenAI |
| `AI_MODEL` | `gpt-4o-mini` | Model yang dipakai. Tetap di sini karena mendukung `temperature`, non-reasoning sehingga risiko timeout rendah, dan harga input-nya murah untuk prompt yang lebih besar dari output-nya |
| `AI_TEMPERATURE` | `0.1` | **Kosongkan agar field-nya tidak dikirim.** Sebagian model GPT-5 menolak parameter ini |
| `AI_REASONING_EFFORT` | `""` | Isi `"none"` untuk model reasoning, supaya reasoning token tidak menambah biaya dan latensi |
| `ENABLE_AI_NARRATIVE_SHADOW` | `true` | AI **menilai dan menyimpan** verdict narasi, tanpa membatalkan trade |
| `ENABLE_AI_NARRATIVE_GATE` | `false` | **Penegakan.** Terpisah dari shadow supaya bukti bisa dikumpulkan sebelum dipercaya |
| `AI_MODEL_NARRATIVE` | `gpt-5.6-luna` | Model khusus narasi. Terverifikasi jalan: 1118 ms dengan `reasoning_effort: none` |
| `AI_TEMPERATURE_NARRATIVE` | `""` | **Wajib kosong.** `gpt-5.6-luna` menolak `temperature` dengan 400 |
| `AI_REASONING_EFFORT_NARRATIVE` | `"none"` | Tanpa ini reasoning token menambah biaya dan latensi |
| `AI_MODEL_EXIT` | `gpt-4o-mini` | Model exit advisor |
| `NARRATIVE_CACHE_TTL_MS` | `86400000` | 24 jam. Narasi statis per token, jadi satu mint cukup dinilai sekali |
| `NARRATIVE_MIN_CONFIDENCE` | `"high"` | Hanya keyakinan setinggi ini yang boleh menolak |
| `AI_NARRATIVE_TIMEOUT_MS` | `8000` | Muat di jendela RugCheck yang memang sudah ditunggu |
| `ENABLE_AI_ENTRY_DECISION` | false | Keputusan entry oleh LLM |
| `AI_CONVICTION_THRESHOLD` | (kode: 75) | Skor keyakinan minimum untuk beli |
| `ENABLE_AI_EXIT_ADVISOR` | true | Advisor exit, berjalan di latar belakang |
| `AI_EXIT_ADVISOR_REFRESH_MS` | 20000 | Interval penyegaran saran |
| `AI_EXIT_ADVISOR_MAX_AGE_MS` | 90000 | Saran lebih tua dari ini diabaikan |
| `AI_EXIT_ADVISOR_MIN_CONFIDENCE` | `high` | Keyakinan minimum agar saran dipakai |
| `AI_EXIT_ADVISOR_ALLOW_EXIT_NOW` | **false** | Izinkan AI menutup posisi. Mati — lihat Keterbatasan |
| `AI_EXIT_ADVISOR_MIN_HOLD_SECONDS` | 90 | Posisi lebih muda dari ini imun dari exit AI |
| `ENABLE_AI_CUTLOSS_DEFENSE` | (kode: false) | Minta LLM memperlebar stop. Jangan dinyalakan |
| `AI_CUTLOSS_MAX_EXTENSION_PERCENT` | (kode: 10) | Pelebaran stop maksimum |
| `AI_CUTLOSS_HARD_FLOOR_PERCENT` | (kode) | Lantai keras pelebaran |
| `AI_CUTLOSS_MAX_DEFENSES_PER_TRADE` | (kode) | Batas pembelaan per trade |
| `AI_CUTLOSS_MIN_CONFIDENCE` | (kode: medium) | Keyakinan minimum pembelaan |
| `HEALTH_CHECK_BEFORE_EARLY_SL` | false | Cek kesehatan AI sebelum stop dini |
| `HEALTH_CHECK_BEFORE_EARLY_TRAILING` | false | Cek kesehatan AI sebelum trailing dini |

Gerbang narasi juga **satu arah**: verdict `WEAK` berkeyakinan tinggi bisa menggugurkan kandidat,
tapi verdict `STRONG` tidak mengubah apa pun. AI tidak pernah bisa membujuk bot masuk ke trade yang
gerbang deterministik belum setujui.

Model tidak diminta mengingat meta yang sedang panas — itu di luar batas pengetahuannya. Prompt-nya
menyertakan nama token yang **baru saja dianalisis bot ini sendiri** beserta volume 5 menitnya,
sebagai bukti apa yang benar-benar diperdagangkan sekarang.

Versi pertama memakai feed `token-boosts` DexScreener untuk ini, dan itu keliru: feed tersebut
adalah **promosi berbayar**, sehingga verdict-nya condong ke apa pun yang sedang dibeli spammer.
Aliran analyzer sendiri bersifat organik dan tidak menambah satu pun panggilan jaringan.

Advisor exit **hanya boleh mempersempit** trailing atau mempercepat exit. Tidak ada jalur yang
mengizinkannya menahan posisi melewati pemicu — invarian itu dikunci oleh test di
`src/ai/exit-advice.spec.ts`.

### Meta trend

Meta adalah tema yang sedang diperdagangkan — meta hewan, meta politik, meta AI, dan seterusnya.
Bot memperlakukannya sebagai **sumbu pencarian pertama**: token di meta yang sedang panas dan
terbukti cuan dinaikkan, token di meta yang terbukti membakar uang diturunkan.

Sebelumnya bagian ini berupa tujuh regex hardcoded yang memberi **+8 flat** ke whale signal score
untuk nama apa pun yang cocok. Bonus itu sama besar untuk semua meta dan buta terhadap waktu, jadi
token bertema kucing dapat bonus identik dengan token bertema politik walaupun salah satunya sedang
mati total. Regex itu sudah dipensiunkan.

**Pelabelan.** Setiap mint dilabeli oleh LLM, sekali seumur hidup, dan disimpan di `TokenMetaLabel`.
Permintaan dikumpulkan dalam buffer dan dikirim **satu request untuk 40 nama**, bukan satu request
per token — inilah yang membuat pelabelan penuh LLM jauh lebih murah daripada gerbang narasi yang
sudah berjalan (yang membayar satu request per mint, atas prompt yang jauh lebih besar, dan
membelinya ulang tiap 24 jam). Model memilih dari kosakata di `MetaVocabulary` dan boleh menciptakan
**paling banyak satu** label baru per batch; tanpa batasan itu model mengarang ejaan baru tiap batch
("dog", "Dogs", "doge meta") dan satu meta panas pecah jadi tiga meta dingin.

Token yang belum berlabel bernilai `unlabeled` dan mendapat penyesuaian skor **nol** — bukan
tebakan. Karena mint yang sama dianalisis ulang tiap detik, labelnya biasanya sudah turun pada pass
kedua atau ketiga.

**Plafon biaya.** Tiga pengunci membuat biaya tidak tumbuh mengikuti throughput scanner: cache
permanen per mint, pelabelan prioritas hanya untuk token yang lolos traksi, dan
`META_LABEL_MAX_PER_HOUR` sebagai plafon keras. Token yang gagal traksi tetap disampel — heat score
harus tahu apa yang dilakukan pasar, bukan cuma apa yang diloloskan filter sendiri — tapi dibatasi
`META_POPULATION_SAMPLE_PER_MIN`. Biaya maksimum per bulan karena itu bisa dihitung di muka.

**Heat score.** Empat sumber bukti digabung jadi satu angka per label, semuanya dinormalisasi ke
persentil lintas-label karena satuannya tidak sebanding:

```text
recentRate   = sightings_recent / META_ACCEL_WINDOW_MIN
baselineRate = (sightings_total - sightings_recent) / (windowMenit - META_ACCEL_WINDOW_MIN)
accel        = recentRate / max(baselineRate, 1 / baselineMenit)

activityScore = (wSight x pct(sightings) + wVol x pct(volume) + wBoost x pct(boosted)
                 + wSocial x pct(social) + wAccel x pct(accel))
                / (wSight + wVol + wBoost + wSocial + wAccel)

heatScore     = n >= META_MIN_TRADE_SAMPLE
                ? META_PNL_WEIGHT x pct(netPnL/trade) + (1 - META_PNL_WEIGHT) x activityScore
                : activityScore
```

**Kenapa ada term akselerasi.** Empat term lainnya mengukur *level* — "ada delapan token hewan di
jendela ini" mengatakan metanya **sudah** terjadi. `accel` mengukur *laju perubahan*, dan itu satu-
satunya term yang bisa mendahului: dev mass-launch tiruan sebuah tema **sebelum** retail masuk, jadi
laju launch per tema adalah sensus real-time atas apa yang builder yakini akan jalan. Tanpa term ini
sebuah meta yang naik dari 2 ke 15 token dalam sejam mendapat skor persis sama dengan meta yang
turun dari 19 ke 1, karena keduanya punya 20 penampakan.

Bentuknya sengaja meniru `volumeSurge` di analyzer, **dan sengaja menghindari jebakan yang formula
itu kena di sana**. `volumeSurge` dulu membagi dengan jumlah bucket tetap tanpa peduli berapa banyak
riwayat yang benar-benar ada, sehingga untuk token muda pembilang dan penyebutnya saling menghapus
dan semua token melaporkan konstanta yang sama. Di sini penjaganya adalah lantai baseline: label yang
seluruh penampakannya ada di irisan terbaru tidak punya pembanding, dan tanpa lantai itu dia akan
membagi nol lalu bertengger di peringkat satu selamanya bermodal tiga penampakan. Memperlakukan
baseline sebagai minimal satu penampakan membuat label baru bisa naik cepat tapi tidak bisa melawan
fisika. Kalau aritmetikanya tidak bermakna, jawabannya `1.0` — datar, tanpa opini.

Di bawah `META_MIN_TRADE_SAMPLE` trade tertutup, label dinilai murni dari aktivitas. Tanpa guard itu
satu trade beruntung akan menobatkan sebuah meta. Di atasnya, P&L realisasi mengambil bobot dominan:
sebuah meta bisa jadi yang paling ramai di chain dan sekaligus cara tercepat kehilangan uang, dan
saat kedua sinyal bertentangan, P&L-lah yang sudah dibayar.

Skornya **relatif**, bukan ambang tetap — sebuah meta panas dibandingkan apa yang sedang jalan
sekarang. Ambang absolut akan melaporkan seluruh chain dingin di malam sepi dan panas saat mania,
keduanya tidak memberi tahu meta mana yang layak dipilih.

**Tier dan pengaruhnya ke skor.**

| Tier | Syarat | Efek ke whale signal score |
| --- | --- | --- |
| `HOT` | heat >= `META_HOT_PERCENTILE` | `+META_BONUS_HOT` |
| `WARM` | di antaranya | `+META_BONUS_WARM` (default 0) |
| `COLD` | heat <= `META_COLD_PERCENTILE` | 0 |
| `TOXIC` | sampel cukup **dan** rugi melewati ambang fee (lihat bawah) | `-META_PENALTY_TOXIC` |
| belum berlabel | — | 0 |

`TOXIC` mengalahkan tier lain dan mengabaikan aktivitas sepenuhnya. Penaltinya jauh lebih besar dari
bonus `HOT` karena kerugiannya tidak simetris: salah menilai meta panas berarti kehilangan satu
trade, salah menilai meta toxic berarti mengisi posisi di sesuatu yang sudah terukur membakar uang.

Asimetri itu disengaja dan arahnya penting: **bonus mengundang token masuk, penalti membuang token
keluar.** Karena itu default-nya condong ke sisi penalti. Perhatikan skalanya terhadap floor yang
ada — `WHALE_SIGNAL_SCORE_FLOOR` hanya 8, jadi bonus `HOT` sebesar 14 dulu setara 175% dari floor
dan bisa meloloskan token tanpa bantuan sinyal lain. Di 8 dia jadi pendorong, bukan penentu.

**Ambang `TOXIC` dikalibrasi dari fee, bukan dari nol.**

```text
ambang = -max(META_TOXIC_FEE_MULTIPLE x rataFeePerTrade, META_TOXIC_MIN_LOSS_USD)
TOXIC  = n >= META_MIN_TRADE_SAMPLE  dan  netPnLPerTrade < ambang
```

Satu putaran beli-jual selalu membayar fee, dan `computeNetProfitUsd` sudah menguranginya. Jadi
sebuah meta yang trade-nya berakhir persis di tempat yang sama tetap melaporkan net **negatif**
sebesar fee itu. Memperlakukan negatif apa pun sebagai bukti meta buruk berarti menghukum meta
**rata-rata**, bukan meta yang jelek — dan dengan gerbang menyala itu akan menolak mayoritas
kandidat begitu sampelnya terkumpul, kebalikan dari selektivitas.

Ambangnya diambil dari fee yang benar-benar dibayar trade tersebut, bukan angka dolar tetap, supaya
tetap benar ketika position size atau harga SOL bergerak. Lantai absolutnya menutupi baris lama yang
`totalFeesSol`-nya kosong: tanpa itu ambangnya runtuh ke nol dan masalahnya kembali.

**Dua titik "meta dulu".** Nama token tidak tersedia saat discovery — PumpPortal hanya mengirim
mint, dan feed DexScreener hanya `{chainId, tokenAddress}`. Jadi prioritas meta diterapkan di dua
tempat yang memang tahu nama:

1. **Skor**, lewat tabel tier di atas. Skornya mengalir ke `MICIN_SIGNAL_SCORE_FLOOR` dan
   `WHALE_SIGNAL_SCORE_FLOOR` yang sudah ada, jadi token di meta panas melewati floor lebih mudah
   dan token di meta toxic jatuh di bawahnya tanpa perlu gerbang baru.
2. **Urutan radar watchlist**, yang mengambil `META_RADAR_OVERSAMPLE` baris lalu mengurutkannya
   berdasarkan heat sebelum memotong ke 20. Token tanpa label mempertahankan urutan umur aslinya,
   jadi tidak pernah kelaparan.

**Gerbang `meta_cold`** (`ENABLE_META_GATE`, default **mati**) mengikuti pola shadow-lalu-tegakkan
yang sama dengan gerbang narasi. Selama mati, setiap kandidat tetap menghasilkan baris log
`meta_shadow ... wouldReject=...`, dan itulah satu-satunya dasar untuk memutuskan apakah gerbangnya
layak dinyalakan.

**Sumber sosial eksternal** (`ENABLE_META_SOCIAL_SOURCE`, default **mati**) adalah satu-satunya
bagian yang butuh kredensial berbayar baru (`X_BEARER_TOKEN`, tier berbayar X API). Tiga sumber
lainnya berasal dari data yang memang sudah lewat. Saat mati, term sosial menghasilkan seri untuk
semua label dan karena itu saling menghapus, bukan menyeret skor turun.

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `AI_MODEL_META` | `gpt-5.6-luna` | Model pelabelan batch |
| `AI_TEMPERATURE_META` | `""` | **Kosongkan.** Model GPT-5 menolak parameter ini dengan 400 |
| `AI_REASONING_EFFORT_META` | `"none"` | Tanpa ini reasoning token menambah biaya dan latensi |
| `META_LABEL_BATCH_SIZE` | 40 | Nama per request. Inti dari kenapa pelabelan penuh LLM murah |
| `META_LABEL_BATCH_INTERVAL_MS` | 20000 | Interval flush buffer kalau belum penuh |
| `META_LABEL_TIMEOUT_MS` | 12000 | Timeout request pelabelan |
| `META_LABEL_MAX_PER_HOUR` | 60 | **Plafon biaya keras.** Di atas ini pelabelan berhenti sampai jam berikutnya |
| `META_POPULATION_SAMPLE_PER_MIN` | 20 | Token gagal-traksi yang tetap dilabeli demi sampel pasar |
| `META_WINDOW_HOURS` | 12 | Jendela rolling semua agregat |
| `META_REFRESH_MS` | 120000 | Interval hitung ulang heat. Pembacaan gate selalu dari memori |
| `META_SIGHTING_DEDUPE_MS` | 300000 | Satu mint dicatat sekali per jendela ini, bukan sekali per detik |
| `META_MIN_TRADE_SAMPLE` | 12 | Trade tertutup minimum sebelum P&L dipercaya |
| `META_TOXIC_FEE_MULTIPLE` | 1.5 | Rugi baru berarti di atas sekian kali biaya fee-nya sendiri |
| `META_TOXIC_MIN_LOSS_USD` | 0.2 | Lantai absolut, dipakai saat data fee tidak ada |
| `META_PNL_WEIGHT` | 0.7 | Bobot P&L setelah sampel cukup |
| `META_WEIGHT_SIGHTINGS` | 0.2 | Bobot jumlah penampakan (level) |
| `META_WEIGHT_VOLUME` | 0.3 | Bobot volume 5 menit |
| `META_WEIGHT_BOOST` | 0.1 | Bobot promosi berbayar |
| `META_WEIGHT_SOCIAL` | 0.1 | Bobot sinyal sosial eksternal |
| `META_WEIGHT_ACCEL` | 0.3 | Bobot akselerasi. Satu-satunya term yang mendahului meta |
| `META_ACCEL_WINDOW_MIN` | 60 | Panjang irisan "sekarang" yang dibandingkan dengan sisa jendela |
| `META_BONUS_HOT` | 8 | Bonus skor tier `HOT`. Ditahan kecil supaya meta tidak bisa meloloskan token sendirian |
| `META_BONUS_WARM` | **0** | Sengaja nol: `WARM` mengenai mayoritas label, jadi bonus di sini hanya menaikkan throughput |
| `META_PENALTY_TOXIC` | 20 | Penalti meta yang terbukti rugi |
| `META_HOT_PERCENTILE` | 80 | Batas bawah `HOT` |
| `META_COLD_PERCENTILE` | 30 | Batas atas `COLD` |
| `META_RADAR_OVERSAMPLE` | 60 | Baris yang diambil radar sebelum diurutkan by heat |
| `ENABLE_META_GATE` | **true** | Reject keras `meta_cold`. Inert sampai sebuah label punya >= `META_MIN_TRADE_SAMPLE` trade tertutup |
| `ENABLE_META_TREND_REPORT` | true | Laporan meta terjadwal |
| `META_TREND_REPORT_HOURS` | 6 | Tiap berapa jam laporan dikirim |
| `ENABLE_META_SOCIAL_SOURCE` | **false** | Sumber sosial eksternal. Butuh `X_BEARER_TOKEN` berbayar |
| `META_SOCIAL_POLL_MS` | 900000 | Interval polling sosial |
| `META_SOCIAL_MAX_LABELS` | 10 | Label terpanas yang ditanyakan per siklus |

Perintah Telegram `/meta` menampilkan leaderboard-nya kapan saja, dengan **net P&L per trade sebagai
angka utama** dan jumlah penampakan sebagai konteks sekunder — bukan sebaliknya.

### Profil matang

Setelan gerbang sekarang menyasar **token yang sudah bertahan**, bukan token yang baru lahir.
Perubahan terpentingnya bukan soal memperketat, tapi soal membuka:

`MAX_AGE_HOURS` sebelumnya `72`, dan `analyzer.service.ts` menolak apa pun di atasnya sebagai
`too_old`. Artinya **tidak satu pun coin berumur lebih dari 3 hari pernah bisa dibeli** — terbukti
di produksi: dari 65 trade yang bisa dicocokkan umurnya, bucket `>3 hari` berisi **nol** trade,
sementara 59 di antaranya (91%) adalah token di bawah 2 jam. Pertanyaan "apakah coin matang lebih
aman" belum pernah benar-benar diuji oleh bot ini.

Feed discovery-nya sendiri memang memuat token matang — sampel 25 token menunjukkan p90 umur 329
jam dan maksimum 4237 jam. Selama ini mereka ditemukan lalu dibuang.

| Knob | Lama | Baru | Alasan |
| --- | --- | --- | --- |
| `MIN_AGE_HOURS` | 0.005 | **2** | 18 detik menjadi 2 jam. Juga mematikan seluruh jalur MICIN (route < 2 jam), sehingga semua knob `MICIN_*` tidak lagi terpakai. **Jangan dinaikkan tanpa membaca catatan di bawah** |
| `MAX_AGE_HOURS` | 72 | **2160** | 90 hari. Tanpa ini semua setelan lain percuma |
| `ESTABLISHED_MAX_AGE_HOURS` | 72 | **2160** | Jalur established ikut dibuka |
| `MIN_LIQUIDITY_USD` | 15000 | **30000** | Pool cukup dalam agar posisi kecil tidak menggerakkan harga |
| `MIN_MCAP` | 2000 | **150000** | $2k itu lotere, bukan proyek. Diturunkan dari 250000 setelah token dengan volume 5m $290k ditolak di mcap $142k |
| `MIN_VOLUME_USD` | 6 | **2000** | Ambang lama praktis tidak menyaring apa pun |
| `MIN_BUY_COUNT` | 1 | **20** | Satu pembeli bukan bukti minat |
| `ANALYZER_MIN_VOLUME_SURGE` | 0.5 | **1.2** | Di 0.5 volume boleh **separuh** baseline dan tetap lolos — itu bukan syarat lonjakan |
| `MIN_BUY_CONFIDENCE` / `BUY_SELL_RATIO_THRESHOLD` | 0.58 / 1.35 | **0.60 / 1.5** | Dominasi pembeli: lever selektivitas yang gratis di posisi kecil |
| `MAX_SINGLE_HOLDER_PCT` / `TOP5` / `TOP10` | 10 / 22 / 30 | **6 / 18 / 26** | Konsentrasi holder adalah ukuran rug yang paling langsung |
| `AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD` | 5000 | **100000** | Query produksi menunjukkan 73% kandidat mendarat di tier holder longgar, jadi tier itulah yang sebenarnya berlaku. Menaikkan ambangnya membuat tier ketat kembali menjadi default |

**Kenapa `MIN_AGE_HOURS` 2 dan bukan 6.** Nilai 6 sempat dipasang dan gagal karena berbenturan
dengan mekanik lain: sebuah token yang ditolak `too_young` tetap dipertahankan radar dan diperiksa
ulang sambil menua, tapi `scanner.service.ts` menandainya `FAILED` setelah **51 pemeriksaan**, dan
radar berjalan tiap ~3 menit. Jatahnya karena itu sekitar **2,5 jam** — token bagus mati kehabisan
pemeriksaan sebelum sempat mencapai 6 jam, sehingga gerbangnya mustahil dilewati lewat jalur
menunggu. Log produksi menunjukkan hal ini secara langsung: token dengan likuiditas $47–74k, mcap
$267k–700k dan dominasi pembeli 60–84% ditolak berulang kali semata karena umurnya menit, lalu
sebagian berakhir di `Stagnant timeout reached (51 checks)`.

Dua jam melewati jendela rug paling ganas dan tetap mematikan jalur MICIN, tapi masih berada di
dalam jatah pemeriksaan. Menaikkannya kembali ke atas ~2,5 jam hanya masuk akal bila batas 51
pemeriksaan itu ikut diubah, atau bila `too_young` dikecualikan dari hitungannya.

**Yang sengaja tidak diubah**, karena produksi membuktikan sebaliknya:

- `TRAILING_DISTANCE_PERCENT` tetap `0.8` — satu-satunya exit yang menghasilkan uang (+$15,06 dari
  26 trade). Melebarkannya merusak satu-satunya yang bekerja.
- `TAKE_PROFIT_PERCENT` tetap `20` — menurunkannya justru **menaikkan** win rate impas, karena fee
  tetap menjadi porsi lebih besar dari target yang lebih kecil (di posisi $5: 47,8% → 56,5%).
- `WHALE_SIGNAL_SCORE_FLOOR` tetap `8` — skor ini tidak memprediksi profitabilitas sama sekali
  (bucket ≥60, 47 trade, tetap rugi -$0,28/trade). Menaikkan floor-nya hanya mengurangi kandidat
  tanpa memperbaiki seleksi.

**Ekspektasi frekuensi.** Dari sampel feed, hanya ~1 dari 25 token memenuhi gabungan ambang ini.
Trade akan datang dalam hitungan per minggu, bukan per hari. Itu konsekuensi yang dipilih, bukan
gejala kesalahan konfigurasi.

### Harga cepat untuk stop loss

`PriceMonitorService` berdetak tiap 1 detik (`@Interval(1000)`), tapi sumber harganya
`api.dexscreener.com/latest/dex/tokens/` — dan feed itu **hanya memperbarui angkanya sekitar sekali
tiap 26 detik**. Diukur langsung terhadap 3 token teraktif selama 90 detik: 3 perubahan dari 84
sampel per detik, jeda terlama 30,3 detik. Jupiter di rentang yang sama bergerak tiap ~6 detik, dan
selisih harga antara keduanya mencapai **25%** pada satu saat.

Memeriksa 1×/detik sebuah angka yang hanya bergerak 1×/26 detik berarti penurunan tidak bisa
terdeteksi tepat waktu. Produksi membuktikannya: stop yang disetel `-8%` mencatat rata-rata trigger
**-17,1%**, dan overshoot itu **rata di semua bucket likuiditas** (-18,7% di bawah $15k, -17,0% di
$25–50k, n=25). Kerataan itulah yang menyingkirkan slippage dan pool tipis sebagai penyebab, dan
menyisakan deteksi yang telat. `exitTriggerPnlPercent` direkam di `persistExitTrigger()` pada saat
**trigger**, bukan saat fill, jadi angka itu memang mengukur deteksi.

Karena itu stop loss — dan **hanya** stop loss — mendapat pendapat kedua dari Jupiter.

```text
stopProfitPercent = min(pnl_dexscreener, pnl_jupiter)
```

Satu arah secara konstruksi: mengambil nilai minimum membuat harga yang lebih segar hanya bisa
**memajukan** stop, tidak pernah menahannya. Kuotasi yang basi, hilang, atau tidak masuk akal
mengembalikan perilaku ke kondisi sekarang, dan kuotasi yang berbeda pendapat tidak pernah bisa
membujuk bot keluar dari exit yang sudah diinginkan basis lama. Setiap mode gagal turun ke perilaku
hari ini, bukan ke posisi rugi yang ditahan terbuka.

**Kenapa hanya stop loss.** `TRAILING_DISTANCE_PERCENT` bernilai 0,8 — angka yang hanya bisa
bertahan karena feed yang lambat meredam noise. Di produksi, `TRAILING_STOP` adalah satu-satunya
exit yang menghasilkan uang: 26 trade, **+$15,06**, rata-rata **+32,4%**. Memberinya harga 6 detik
akan memicunya oleh riak biasa dan menghancurkan satu-satunya jalur yang bekerja. Take profit,
dynamic hold zone, dan seluruh guard juga tetap memakai basis lama.

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `ENABLE_FAST_STOP_PRICE` | true | Pendapat kedua Jupiter untuk kondisi stop loss |
| `FAST_STOP_PRICE_MAX_AGE_MS` | 10000 | Di atas ini kuotasi dianggap basi dan diabaikan |
| `ENABLE_AI_CUTLOSS_DEFENSE` | **false** | Dimatikan eksplisit. Produksi: 4 trade, **-$4,13**, nol menang |

### Scanner, watchlist, dan retry

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `SCANNER_MAX_CONCURRENT` | 80 | Analisis bersamaan maksimum |
| `SCANNER_POLLING_INTERVAL` | 1000 | Interval polling discovery (ms) |
| `SCANNER_RADAR_INTERVAL` | 4000 | Interval radar watchlist (ms) |
| `SCANNER_HEARTBEAT_INTERVAL` | 3000 | Interval heartbeat (ms) |
| `SCANNER_RECHECK_DELAY_MS` | 1000 | Jeda sebelum cek ulang |
| `ANALYZER_MAX_SCAN_DURATION_MIN` | 12 | Setelah ini, `stagnant_timeout` |
| `NO_DEX_PAIR_MAX_RETRIES` | 6 | Retry saat pair belum terindeks |
| `NO_DEX_PAIR_RETRY_BASE_MS` | 1000 | Basis backoff |
| `ZERO_LIQUIDITY_MAX_RECHECKS` | 15 | Cek ulang likuiditas nol |
| `ZERO_LIQUIDITY_MAX_RETRIES` | 8 | Retry aktif likuiditas nol |
| `ZERO_LIQUIDITY_RETRY_BASE_MS` | 2000 | Basis backoff |
| `ZERO_LIQUIDITY_ACTIVE_RETRY_MAX_AGE_MIN` | 15 | Batas umur token untuk retry aktif |
| `WATCHLIST_STATUS_UPDATE_INTERVAL_MS` | 45000 | Interval update status watchlist |
| `DETAIL_PRICE_CACHE_TTL_MS` | 500 | TTL cache harga detail |
| `SOL_PRICE_CACHE_MAX_AGE_MS` | 60000 | Umur maksimum cache harga SOL |
| `SOL_PRICE_REFRESH_INTERVAL_MS` | 2000 | Harga SOL disajikan dari cache selama ini |

### Jalur established (rebound / CTO)

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `ESTABLISHED_MIN_AGE_HOURS` | 18 | Umur minimum |
| `ESTABLISHED_MAX_AGE_HOURS` | 72 | Umur maksimum |
| `ESTABLISHED_MIN_BUYS` | 4 | Pembeli minimum |
| `MIN_ESTABLISHED_LIQUIDITY` | 2000 | Likuiditas minimum |
| `MAX_ESTABLISHED_MCAP` | 300000 | Market cap maksimum |
| `REBOUND_PRICE_DROP_PCT` | -40 | Penurunan yang dianggap kandidat rebound |
| `VOLUME_SPIKE_RATIO` | 0.2 | Rasio lonjakan volume |

### Telegram dan startup

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `ENABLE_STARTUP_UPDATE_BROADCAST` | true | Siarkan pesan saat boot |
| `STARTUP_UPDATE_BROADCAST_DELAY_MS` | 5000 | Jeda sebelum siaran |

---

---

## Menjalankan

```bash
yarn install
npx prisma generate
npx prisma db push                    # sinkronkan skema

yarn start:dev                        # development
yarn build && node dist/src/main.js   # produksi
```

Env minimal: `DATABASE_URL`, `SOLANA_RPC_URL`, `TELEGRAM_BOT_TOKEN`, `JUPITER_API_KEY`,
`OPENAI_API_KEY`, `HELIUS_WEBHOOK_SECRET`, `API_SECRET_KEY`. `SOLANA_RPC_URL` harus URL Helius
berisi `api-key` bila analisis aliran dana Helius dipakai — kuncinya diambil dari situ.

Tiga hal yang perlu diketahui sebelum menjalankan:

- **Jalankan dari root repo.** `config.json` dibaca relatif terhadap `process.cwd()`, dan bila tidak
  ditemukan seluruh knob jatuh ke default hardcoded tanpa satu baris log pun. Lihat catatan di
  [Referensi Konfigurasi](#referensi-konfigurasi).
- **Jangan pakai `yarn start:prod`.** Script-nya menunjuk `dist/main` sementara build menghasilkan
  `dist/src/main.js`. Container produksi (`Dockerfile`) menjalankan `yarn start:dev`.
- **Saat menjalankan lokal, timpa `TELEGRAM_BOT_TOKEN` dengan `your_telegram_bot_token`.** Nilai itu
  mematikan polling Telegram dan mengarahkan alert ke konsol, sehingga instance lokal tidak berebut
  update stream dengan bot produksi.

Verifikasi:

```bash
yarn test          # 286 tes / 17 suite
npx tsc --noEmit
npx eslint src/
```

`scratch/analyzer-live-probe.ts` menjalankan `AnalyzerService.isTokenSafeToBuy()` yang asli terhadap
token live dengan database distub, dan melaporkan gerbang mana yang menolak setiap token. Probe
membaca `process.env` lebih dulu, jadi ambang bisa ditimpa tanpa menyentuh `config.json`:

```bash
MIN_H1_BUY_SHARE=0.6 npx ts-node -r tsconfig-paths/register scratch/analyzer-live-probe.ts
```

---

Test `documents every config knob` di `src/config/runtime-config.spec.ts` memastikan setiap knob di
`config.json` muncul di dokumen ini. Menambah knob tanpa mendokumentasikannya membuat build merah.

