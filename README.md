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
avgVolume_5m   = volume_1h / 12
volumeSurge    = volume_5m / avgVolume_5m
zScore         = (volume_5m - avgVolume_5m) / (avgVolume_5m x 0.5)

confidenceScore = buys_5m / (buys_5m + sells_5m)
vlRatio         = volume_5m / liquidity
volScore        = vlRatio x confidenceScore
velocity        = volume_5m / marketCap

buyShare_1h     = buys_1h / (buys_1h + sells_1h)
```

Perhatikan `zScore` memakai asumsi standar deviasi = 0,5 x rata-rata, bukan stddev sebenarnya, dan
baseline-nya diturunkan dari jendela 1 jam sementara pembilangnya 5 menit. Ini pseudo z-score;
berguna sebagai peringkat relatif, bukan sebagai ukuran statistik.

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

| Knob | Nilai | Keterangan |
| --- | --- | --- |
| `DAILY_MAX_LOSS_USD` | 2.5 | Batas rugi harian |
| `MAX_CONSECUTIVE_LOSSES` | 2 | Rugi berurutan global |
| `MICIN_MAX_CONSECUTIVE_LOSSES` | 2 | Rugi berurutan MICIN |
| `WHALE_MAX_CONSECUTIVE_LOSSES` | 3 | Rugi berurutan WHALE |
| `MAX_DRAWDOWN_PCT` | 25 | Drawdown maksimum |
| `RISK_CONSECUTIVE_LOOKBACK_HOURS` | 2 | Jendela hitung rugi berurutan |
| `RISK_APPLY_TO_MANUAL` | false | Terapkan risk breaker ke trade manual |
| `RISK_PNL_START_AT` | `2026-07-22T22:24:23+07:00` | Titik awal akumulasi P&L |
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
| `AI_MODEL` | `gpt-4o-mini` | Model yang dipakai |
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

Advisor exit **hanya boleh mempersempit** trailing atau mempercepat exit. Tidak ada jalur yang
mengizinkannya menahan posisi melewati pemicu — invarian itu dikunci oleh test di
`src/ai/exit-advice.spec.ts`.

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

