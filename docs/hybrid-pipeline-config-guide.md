# Hybrid Pipeline Config Guide

Dokumen ini menjelaskan konfigurasi bot yang aktif sekarang, rumus yang dipakai di code, flow dari scan sampai close trade, dan dampak tiap angka.

Sumber utama implementasi:
- `config.json`
- `src/analyzer/analyzer.service.ts`
- `src/scanner/scanner.service.ts`
- `src/trade/trade.service.ts`
- `src/price-monitor/price-monitor.service.ts`
- `src/config/runtime-config.ts`

## 1. Ringkasan Arsitektur

Bot sekarang memakai satu pipeline hybrid.

Flow besar:
1. Scanner discovery token.
2. Analyzer hitung quant metrics.
3. Analyzer assign route `MICIN` atau `WHALE`.
4. Analyzer cek safety, holder risk, creator risk, social strength.
5. AI conviction judge memberi keputusan `buy/skip` dan `positionSizeMultiplier`.
6. TradeService hitung ukuran buy final.
7. Guard modal, slot, slippage, price impact, dan risk breaker berjalan sebelum swap.
8. Buy dieksekusi.
9. Price monitor memantau posisi terbuka.
10. Sell dipicu oleh stop loss, take profit, trailing stop, atau emergency exit.

## 2. Runtime Truth vs Target Refactor

Bagian ini penting supaya guide tidak bentrok dengan implementasi sekarang dan arah refactor notifikasi berikutnya.

### 2.1 Current runtime behavior

Perilaku code saat ini:
- hard fail / permanent fail tidak mengirim `SECOND-WAVE RADAR`
- hard fail saat ini juga di-suppress dari Telegram oleh scanner, jadi tidak otomatis kirim `WATCHLIST BLOCKED`
- soft reason hanya masuk radar jika termasuk allowlist runtime:
  - `low_surge`
  - `no_volume_anomaly`
  - `low_vol_score`
  - `whale_signal_too_weak`
- `low_metrics`, `ai_rejected`, dan `noisy_pump` saat ini bukan radar candidate
- signal yang lolos analyzer akan kirim `MUST BUY SIGNAL - EXECUTION ATTEMPTING` untuk live mode atau `MUST BUY SIGNAL - DRY RUN` untuk dry run
- buy yang gagal di execution layer bisa mengirim `BUY EXECUTION FAILED`

### 2.2 Target notification semantics

Target semantik notifikasi yang diinginkan:
- hard permanent fail tidak boleh pernah mengirim `SECOND-WAVE RADAR`
- jika token sudah berada dalam monitoring cycle, hard fail boleh mengirim satu terminal `WATCHLIST BLOCKED`, lalu monitoring dihentikan
- soft fail radar-eligible mengirim `SECOND-WAVE RADAR` sekali, lalu update status ditahan oleh throttle
- signal valid harus dipisahkan jelas dari execution result:
  - signal valid -> `MUST BUY SIGNAL - EXECUTION ATTEMPTING`
  - execution gagal -> `BUY EXECUTION FAILED`
  - execution sukses -> `BUY EXECUTED`

### 2.3 Invariant notifikasi

Invariant yang harus dianggap source of truth:
1. Permanent hard fail tidak boleh emit `SECOND-WAVE RADAR` di cycle yang sama.
2. Safe signal tidak boleh emit `SECOND-WAVE RADAR`.
3. Execution failure tidak membatalkan kualitas signal. Itu berarti analyzer lolos, tapi buy gagal di layer risk/capital/quote/swap.

## 3. Config JSON Aktif Saat Ini

```json
{
  "MARKET_REGIME": "balanced",
  "TOTAL_CAPITAL": 25,
  "RESERVE_AMOUNT": 10,
  "DYNAMIC_RESERVE_RATIO": 0.2,
  "MIN_RESERVE_USD": 1,
  "MAX_RESERVE_USD": 10,
  "TOTAL_SLOTS": 2,
  "POSITION_SIZE_USD": 3,
  "MICIN_POSITION_SIZE_MULTIPLIER": 0.7,
  "WHALE_POSITION_SIZE_MULTIPLIER": 1,
  "SLIPPAGE_BPS": 100,
  "MICIN_MAX_SLIPPAGE_BPS": 300,
  "WHALE_MAX_SLIPPAGE_BPS": 150,
  "TAKE_PROFIT_PERCENT": 15,
  "STOP_LOSS_PERCENT": 12,
  "TRAILING_DISTANCE_PERCENT": 1.5,
  "MICIN_TRAILING_ACTIVATION_PERCENT": 10,
  "WHALE_TRAILING_ACTIVATION_PERCENT": 8,
  "MICIN_TRAILING_DISTANCE_PERCENT": 5,
  "WHALE_TRAILING_DISTANCE_PERCENT": 3,
  "MICIN_TAKE_PROFIT_PERCENT": 22,
  "WHALE_TAKE_PROFIT_PERCENT": 15,
  "MICIN_STOP_LOSS_PERCENT": 12,
  "WHALE_STOP_LOSS_PERCENT": 10,
  "DISABLE_SL_PATIENCE": true,
  "MIN_MCAP": 5000,
  "MAX_MCAP": 3000000,
  "MIN_AGE_HOURS": 0.02,
  "MAX_AGE_HOURS": 72,
  "MIN_BUY_CONFIDENCE": 0.6,
  "RUGCHECK_MIN_SAFETY_INDEX": 0.8,
  "MIN_LIQUIDITY_USD": 5000,
  "MIN_VOLUME_USD": 200,
  "MIN_BUY_COUNT": 3,
  "MIN_VL_RATIO": 0.08,
  "MIN_VOLUME_MCAP_RATIO": 0.05,
  "ANALYZER_MIN_VOL_SCORE": 0.02,
  "ANALYZER_MIN_Z_SCORE": 1.5,
  "ANALYZER_MIN_VOLUME_SURGE": 1.5,
  "ESTABLISHED_MIN_AGE_HOURS": 24,
  "ESTABLISHED_MAX_AGE_HOURS": 72,
  "ESTABLISHED_MIN_BUYS": 5,
  "MIN_ESTABLISHED_LIQUIDITY": 3000,
  "MAX_ESTABLISHED_MCAP": 200000,
  "REBOUND_PRICE_DROP_PCT": -50,
  "VOLUME_SPIKE_RATIO": 0.25,
  "BUY_SELL_RATIO_THRESHOLD": 1.5,
  "SCANNER_MAX_CONCURRENT": 40,
  "SCANNER_POLLING_INTERVAL": 5000,
  "SCANNER_RADAR_INTERVAL": 15000,
  "SCANNER_HEARTBEAT_INTERVAL": 5000,
  "SCANNER_RECHECK_DELAY_MS": 5000,
  "WATCHLIST_STATUS_UPDATE_INTERVAL_MS": 120000,
  "ANALYZER_MAX_SCAN_DURATION_MIN": 10,
  "TRADE_TIMEOUT_MS": 15000,
  "TRADE_MAX_RETRIES": 5,
  "TRADE_PRIORITY_MULTIPLIER": 3,
  "MAX_PRICE_IMPACT_PCT": 10,
  "MICIN_MAX_PRICE_IMPACT_PCT": 2.5,
  "WHALE_MAX_PRICE_IMPACT_PCT": 1,
  "USE_JITO": true,
  "JITO_TIP_SOL": 0.001,
  "JITO_BLOCK_ENGINE_URL": "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "TRADE_DUST_THRESHOLD": 0.000001,
  "TRADE_FEE_CUSHION_SOL": 0.005,
  "DAILY_MAX_LOSS_USD": 2,
  "MAX_CONSECUTIVE_LOSSES": 2,
  "MICIN_MAX_CONSECUTIVE_LOSSES": 3,
  "WHALE_MAX_CONSECUTIVE_LOSSES": 2,
  "MAX_DRAWDOWN_PCT": 20,
  "DISABLE_BUY_UNTIL": "",
  "RISK_APPLY_TO_MANUAL": false,
  "AI_BASE_URL": "https://api.openai.com/v1",
  "AI_MODEL": "gpt-4o-mini",
  "AI_CONVICTION_THRESHOLD": 75,
  "WHALE_SIGNAL_SCORE_FLOOR": 45,
  "COOLDOWN_WIN_HOURS": 6,
  "COOLDOWN_LOSS_HOURS": 24
}
```

## 4. Formula Utama

### 4.1 Route assignment

```ts
route = ageHours < 2 ? 'MICIN' : 'WHALE'
```

Makna:
- `MICIN`: token muda, sizing lebih kecil, guard execution lebih longgar.
- `WHALE`: token lebih matang, size lebih penuh, social/narrative lebih penting, price impact lebih ketat.

### 4.2 Momentum formulas

```ts
confidenceScore = buys5m / (buys5m + sells5m)
vlRatio = volume5m / liquidity
volScore = vlRatio * confidenceScore
avgVol5m = volume1h / 12
zScore = (volume5m - avgVol5m) / (avgVol5m * 0.5 || 1)
volumeSurge = volume5m / (avgVol5m || 1)
velocity = volume5m / marketCap
```

Makna tiap formula:
- `confidenceScore`: dominasi buyer di 5 menit terakhir.
- `vlRatio`: tekanan volume terhadap likuiditas.
- `volScore`: gabungan tekanan volume dan dominasi buyer.
- `zScore`: seberapa abnormal volume sekarang dibanding baseline 1 jam.
- `volumeSurge`: percepatan volume 5 menit terhadap rata-rata 5 menit dari 1 jam terakhir.
- `velocity`: seberapa cepat volume bergerak relatif terhadap market cap.

### 4.3 Final buy size

```ts
finalBuyUsd = basePositionSizeUsd * routeMultiplier * aiMultiplier
```

Dengan:
- `basePositionSizeUsd`: dari setting Telegram chat, fallback ke `POSITION_SIZE_USD`.
- `routeMultiplier`: `MICIN_POSITION_SIZE_MULTIPLIER` atau `WHALE_POSITION_SIZE_MULTIPLIER`.
- `aiMultiplier`: output AI, di-clamp ke range `0.1 - 1.0`.

Contoh:
- Base `$3`, route `MICIN`, AI `1.0` -> `$3 * 0.7 * 1.0 = $2.10`
- Base `$3`, route `WHALE`, AI `1.0` -> `$3 * 1.0 * 1.0 = $3.00`
- Base `$3`, route `WHALE`, AI `0.6` -> `$3 * 1.0 * 0.6 = $1.80`

### 4.4 Dynamic reserve and capital guard

```ts
dynamicReserveUsd = clamp(balanceUsd * DYNAMIC_RESERVE_RATIO, MIN_RESERVE_USD, MAX_RESERVE_USD)
spendableCapitalUsd = max(balanceUsd - dynamicReserveUsd, 0)
openExposureUsd = sum(openTrade.entryValueUsd)
committedCapitalUsd = openExposureUsd + finalBuyUsd
allowBuy = committedCapitalUsd <= spendableCapitalUsd
```

Catatan penting:
- Guard live memakai balance wallet real.
- `TOTAL_CAPITAL` dan `RESERVE_AMOUNT` bukan sumber balance live utama.
- `RESERVE_AMOUNT` dipakai untuk startup validation dan context AI, bukan reserve runtime utama.

### 4.5 Slippage selection

```ts
requestedSlippageBps = telegramSlippageOnSol * 10000 || SLIPPAGE_BPS
selectedSlippageBps = min(requestedSlippageBps, routeMaxSlippageBps)
```

Contoh:
- Telegram `0.50%` -> `0.005 * 10000 = 50 bps`
- Whale cap `150 bps` -> selected `50`
- User minta `5%` -> `500 bps`
  - Micin -> capped ke `300`
  - Whale -> capped ke `150`

### 4.6 Price impact guard

```ts
normalizedPriceImpactPct = raw > 0 && raw < 1 ? raw * 100 : raw
allowQuote = normalizedPriceImpactPct <= routeMaxPriceImpactPct
```

### 4.7 Risk breaker

```ts
if dailyRealizedPnlUsd <= -DAILY_MAX_LOSS_USD -> block
if consecutiveLosses >= routeMaxConsecutiveLosses -> block
if totalRealizedPnlUsd <= -(TOTAL_CAPITAL * MAX_DRAWDOWN_PCT / 100) -> block
if now < DISABLE_BUY_UNTIL -> block
```

Dengan config sekarang:
```ts
maxDrawdownUsd = 25 * 20 / 100 = 5
```

Kalau total realized PnL <= `-5`, buy baru diblok.

Peringatan operasional:
- ini bukan analyzer bug
- ini portfolio lockout
- kalau historical realized PnL sudah jauh negatif, bot bisa terus terkunci sampai baseline capital atau risk state direset sesuai policy

Contoh:
- `TOTAL_CAPITAL = 25`
- `MAX_DRAWDOWN_PCT = 20`
- drawdown floor = `-5`
- jika total realized PnL sudah `-65.01`, semua live buy akan gagal di layer pre-swap dengan alasan drawdown/risk breaker

### 4.8 Trailing stop

```ts
if profitPct >= trailingActivationPct:
  trailingStop = currentPrice * (1 - trailingDistancePct / 100)
```

Jika profit sudah >= 15%, bot mengunci minimal sekitar break-even plus 2%:

```ts
breakEvenPlus = entryPrice * 1.02
trailingStop = max(trailingStop, breakEvenPlus)
```

## 5. Flow End-to-End Dari Scan Sampai Sell

### 5.1 Discovery
Scanner mengambil token dari:
- PumpPortal WS
- polling DexScreener

Token masuk active monitor.

### 5.2 Analyzer market traction
Analyzer menjalankan filter murah dulu:
- `MIN_LIQUIDITY_USD`
- `MIN_VOLUME_USD`
- `MIN_BUY_COUNT`
- `MIN_MCAP`
- `MAX_MCAP`
- `MIN_AGE_HOURS`
- `MAX_AGE_HOURS`

Jika gagal di sini, token reject cepat tanpa proses mahal.

### 5.3 Quant momentum gates
Analyzer lalu cek:
- `ANALYZER_MIN_VOLUME_SURGE`
- `ANALYZER_MIN_VOL_SCORE`
- `ANALYZER_MIN_Z_SCORE`
- `MIN_BUY_CONFIDENCE`
- `MIN_VL_RATIO`
- `MIN_VOLUME_MCAP_RATIO`

### 5.4 Route-specific behavior
- `MICIN`: noise gate aktif.
- `WHALE`: social + narrative gate aktif lewat `whaleSignalScore`.

### 5.5 Security gates
Analyzer cek:
- Safety RPC
- RugCheck
- creator profile
- holder concentration
- creator blacklist / creator risk

### 5.6 AI conviction layer
Kalau AI key ada:
- AI menerima route, quant metrics, whale signal, social booleans, dan risk profile.
- AI return `action`, `cuanConvictionScore`, dan `positionSizeMultiplier`.

Gate:
```ts
if action !== 'buy' || conviction < AI_CONVICTION_THRESHOLD:
  skip
```

### 5.7 Telegram state semantics

#### Current runtime
- `SECOND-WAVE RADAR`: soft candidate, monitoring started
- `WATCHLIST WAITING`: soft fail yang masih layak dipantau, tapi hanya untuk radar-eligible reasons
- `WATCHLIST REJECTED`: dipakai di reporting mapping untuk non-permanent reject seperti `ai_rejected` atau `noisy_pump`
- `WATCHLIST BLOCKED`: tersedia di reporting layer untuk hard fail, tetapi current scanner belum selalu mengirimkannya
- `MUST BUY SIGNAL - EXECUTION ATTEMPTING`: signal layer valid di live mode
- `BUY EXECUTION FAILED`: signal valid, execution denied/failed
- `BUY EXECUTED`: trade opened

#### Target semantics
- `SECOND-WAVE RADAR` = hanya soft candidate
- `WATCHLIST WAITING` = soft fail, masih dimonitor
- `WATCHLIST REJECTED` = analyzer reject non-permanent / non-security
- `WATCHLIST BLOCKED` = permanent/security hard fail terminal
- `MUST BUY SIGNAL - EXECUTION ATTEMPTING` = signal valid
- `BUY EXECUTION FAILED` = signal valid, execution layer gagal
- `BUY EXECUTED` = posisi benar-benar terbuka

### 5.8 Radar eligibility

#### Radar-eligible sekarang
- `low_surge`
- `no_volume_anomaly`
- `low_vol_score`
- `whale_signal_too_weak`

#### Non-radar soft reject
- `low_metrics`
- `ai_rejected`
- `noisy_pump`

#### Hard / blocked reasons
- `high_risk_score`
- `high_concentration`
- `creator_high_risk`
- `safety_rpc_failed`
- `zero_liquidity` saat sudah dianggap permanent

Catatan:
- `low_metrics` saat ini tidak masuk radar candidate walaupun reporting mapping lama masih bisa menandainya sebagai `WAITING`
- ini dianggap semantic mismatch yang perlu dibersihkan jika notifikasi direfaktor penuh

### 5.9 Buy execution flow
Urutan di `TradeService`:
1. ambil settings Telegram per chat
2. cek cooldown token
3. cek slot guard
4. hitung `finalBuyUsd`
5. cek risk breaker
6. ambil harga SOL
7. ambil balance wallet real
8. hitung dynamic reserve
9. cek capital guard
10. cek balance guard
11. request Jupiter quote
12. cap slippage
13. cek price impact
14. execute swap
15. simpan trade ke DB

### 5.10 Open trade monitoring
`PriceMonitorService` jalan tiap 2 detik.

Yang dicek:
- PnL sekarang
- fresh market signals
- noise pressure
- dev dump
- whale dump
- hard crash
- stop loss
- trailing activation
- partial TP
- trailing stop

### 5.11 Sell flow
Sell bisa terjadi karena:
- `STOP_LOSS`
- `PARTIAL_TAKE_PROFIT`
- `TRAILING_STOP`
- `RUGPULL`
- `DEV_DUMP`
- `PANIC_SELL`

## 6. Known Limitation: DexScreener Pair Selection

Current implementation belum dijelaskan sebagai pair-ranking engine yang ketat. Ini adalah risk point penting.

Risiko operasional:
- pair pertama / pair yang salah bisa punya liquidity tipis
- volume dan mcap bisa terdistorsi
- price impact guard bisa menghitung dari pool yang salah
- token valid bisa false reject
- token jelek bisa false accept

Target improvement yang ideal:
- filter hanya pair `solana`
- buang pair dengan liquidity nol
- pilih pair dengan liquidity terdalam
- kalau perlu, ranking pair dengan kombinasi liquidity + volume + aktivitas transaksi

Sampai itu diimplementasi penuh, anggap pair selection DexScreener sebagai known limitation analyzer/execution.

## 7. Tabel Config Lengkap: Key -> Rumus/Pemakaian -> Dampak -> Saran Tuning

### 7.1 Modal dan kapasitas

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `TOTAL_CAPITAL` | Dipakai di risk breaker dan startup validation | Menentukan batas drawdown portfolio, bukan balance wallet live | Samakan dengan modal strategis yang memang mau dianggap akun bot |
| `RESERVE_AMOUNT` | Dipakai di startup validation + AI context | Bukan reserve live utama | Biarkan sebagai sanity number |
| `DYNAMIC_RESERVE_RATIO` | `balanceUsd * ratio` | Makin besar, makin kecil modal aktif | `0.15 - 0.25` |
| `MIN_RESERVE_USD` | floor reserve dinamis | Menjaga sisa fee dan modal minimum | `1 - 2` |
| `MAX_RESERVE_USD` | cap reserve dinamis | Biar reserve tidak membengkak | `5 - 10` |
| `TOTAL_SLOTS` | maksimum posisi open per chat | Mengatur concurrency | Wallet kecil: `2` |
| `POSITION_SIZE_USD` | base size sebelum multiplier | Ukuran entry default | Wallet kecil/menengah: `2.5 - 4` |

### 7.2 Sizing multipliers

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `MICIN_POSITION_SIZE_MULTIPLIER` | `finalBuyUsd = base * routeMult * aiMult` | Mengecilkan size micin | `0.5 - 0.8` |
| `WHALE_POSITION_SIZE_MULTIPLIER` | sama | Whale pakai size lebih penuh | `0.9 - 1.0` |
| `AI positionSizeMultiplier` | output AI, clamp `0.1 - 1.0` | AI bisa menurunkan size saat conviction tidak penuh | Biarkan default |

### 7.3 Momentum filters

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `MIN_LIQUIDITY_USD` | liquidity minimal | Buang token terlalu tipis | Micin `5000-15000`, Whale `10000+` |
| `MIN_VOLUME_USD` | volume 5m minimal | Buang token sepi | `200` cukup rendah |
| `MIN_BUY_COUNT` | buys 5m minimal | Buang token tanpa flow real | `3-5` |
| `MIN_BUY_CONFIDENCE` | `buys / (buys+sells)` | Filter buy pressure | `0.6 - 0.65` |
| `MIN_VL_RATIO` | `volume5m / liquidity` | Tekanan volume terhadap LP | `0.05 - 0.10` |
| `MIN_VOLUME_MCAP_RATIO` | `volume5m / marketCap` | Filter velocity lemah | `0.03 - 0.08` |
| `ANALYZER_MIN_VOL_SCORE` | `(volume5m/liquidity) * confidence` | Filter shock volume lemah | `0.02` longgar |
| `ANALYZER_MIN_Z_SCORE` | pseudo anomaly z-score | Butuh volume anomaly | `1.3 - 1.8` |
| `ANALYZER_MIN_VOLUME_SURGE` | `volume5m / (volume1h/12)` | Butuh percepatan volume | `1.5 - 2.0` |

### 7.4 Market shape

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `MIN_MCAP` | floor market cap | Buang dust token | `5000` cocok hybrid micin |
| `MAX_MCAP` | ceiling market cap | Buang token terlalu besar/lambat | `1.5m - 3m` |
| `MIN_AGE_HOURS` | umur minimal | Hindari token terlalu mentah | `0.02` sekarang sekitar 1.2 menit |
| `MAX_AGE_HOURS` | umur maksimal scanner | Buang token terlalu tua | `48 - 72` |
| `ESTABLISHED_MIN_AGE_HOURS` | helper established route | Token matang | `24` |
| `ESTABLISHED_MAX_AGE_HOURS` | helper established route | Batas atas token matang | `72` |

### 7.5 Whale and social layer

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `WHALE_SIGNAL_SCORE_FLOOR` | floor whale score | Makin tinggi, whale makin strict | `40 - 50` |
| social booleans | masuk whale score | Filter token tua tanpa komunitas | Harus tetap aktif |
| narrative match | bonus whale score | Bias ke meta yang lagi hidup | Biarkan |

### 7.6 Execution guards

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `SLIPPAGE_BPS` | slippage fallback global | Default tolerance | `100` bagus |
| `MICIN_MAX_SLIPPAGE_BPS` | cap slippage micin | Menahan bad fill micin | `200 - 300` |
| `WHALE_MAX_SLIPPAGE_BPS` | cap slippage whale | Whale harus rapih | `100 - 150` |
| `MAX_PRICE_IMPACT_PCT` | fallback impact global | Guard generic | `10` boleh fallback |
| `MICIN_MAX_PRICE_IMPACT_PCT` | cap impact micin | Hindari fill jelek | `2.0 - 3.0` |
| `WHALE_MAX_PRICE_IMPACT_PCT` | cap impact whale | Whale harus ketat | `0.75 - 1.25` |
| `TRADE_FEE_CUSHION_SOL` | cushion fee | Sisakan SOL untuk fee dan retry | `0.005` oke |
| `TRADE_TIMEOUT_MS` | timeout request trade | Lindungi bot dari request macet | `10000 - 15000` |
| `TRADE_MAX_RETRIES` | retry swap/quote | Lebih tahan error, tapi lebih agresif | `3 - 5` |

### 7.7 Risk breaker

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `DAILY_MAX_LOSS_USD` | block jika daily realized <= `-value` | Kill switch harian | Wallet kecil: `2 - 3` |
| `MAX_CONSECUTIVE_LOSSES` | fallback loss streak | Stop revenge trading | `2` |
| `MICIN_MAX_CONSECUTIVE_LOSSES` | route-specific streak | Micin boleh lebih tahan | `3` |
| `WHALE_MAX_CONSECUTIVE_LOSSES` | route-specific streak | Whale lebih ketat | `2` |
| `MAX_DRAWDOWN_PCT` | drawdown portfolio max | Guard modal total | `15 - 25` |
| `DISABLE_BUY_UNTIL` | freeze sampai timestamp | Emergency stop manual | kosong saat normal |
| `RISK_APPLY_TO_MANUAL` | apply breaker ke manual buy | Kalau `false`, manual buy lebih bebas | `false` untuk debug |

### 7.8 Exit settings

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `STOP_LOSS_PERCENT` | fallback SL | Backup global | Dipakai kalau route override tidak ada |
| `TAKE_PROFIT_PERCENT` | fallback TP | Backup global | Dipakai kalau route override tidak ada |
| `TRAILING_DISTANCE_PERCENT` | fallback trailing | Backup global | Dipakai kalau route override tidak ada |
| `MICIN_STOP_LOSS_PERCENT` | SL micin | Kendali loss micin | `10 - 14` |
| `WHALE_STOP_LOSS_PERCENT` | SL whale | Whale lebih rapat | `8 - 12` |
| `MICIN_TAKE_PROFIT_PERCENT` | TP micin | Target upside micin | `18 - 30` |
| `WHALE_TAKE_PROFIT_PERCENT` | TP whale | Target upside whale | `12 - 20` |
| `MICIN_TRAILING_ACTIVATION_PERCENT` | trailing start micin | Cegah exit terlalu cepat | `10 - 15` |
| `WHALE_TRAILING_ACTIVATION_PERCENT` | trailing start whale | Whale lebih cepat lock | `8 - 12` |
| `MICIN_TRAILING_DISTANCE_PERCENT` | trailing distance micin | Harus lebih lebar | `4 - 8` |
| `WHALE_TRAILING_DISTANCE_PERCENT` | trailing distance whale | Lebih ketat | `2.5 - 5` |

### 7.9 Scanner timing

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `SCANNER_MAX_CONCURRENT` | limit monitor aktif | Beban CPU/memory | `40` aman |
| `SCANNER_POLLING_INTERVAL` | interval polling discovery | Responsif vs beban | `5000ms` |
| `SCANNER_RADAR_INTERVAL` | interval radar background | Pengaruh retry watchlist | `15000ms` |
| `SCANNER_HEARTBEAT_INTERVAL` | interval log heartbeat | Observability | `5000ms` |
| `SCANNER_RECHECK_DELAY_MS` | delay recheck | Anti spam reprocess | `5000ms` |
| `WATCHLIST_STATUS_UPDATE_INTERVAL_MS` | throttle update Telegram | Anti spam watchlist | `120000ms` bagus |

### 7.10 AI layer

| Key | Rumus / Pemakaian | Dampak | Saran Tuning |
|---|---|---|---|
| `AI_BASE_URL` | endpoint AI | Infrastruktur | jangan ubah kecuali provider berubah |
| `AI_MODEL` | model conviction | Kualitas AI judge | `gpt-4o-mini` cukup cepat |
| `AI_CONVICTION_THRESHOLD` | buy jika score >= threshold | Makin tinggi, makin ketat | `70 - 80` |
| `MARKET_REGIME` | label konteks AI / guide | Saat ini tidak mengubah math core execution | Anggap `AI-only` sampai ada route/threshold tuning berbasis regime |

Catatan `MARKET_REGIME`:
- saat ini tidak langsung mengubah threshold quant
- tidak langsung mengubah sizing
- tidak langsung mengubah slippage cap
- tidak langsung mengubah risk breaker

## 8. Contoh Perhitungan Nyata

### 8.1 Wallet $10, belum ada posisi

```ts
balanceUsd = 10
dynamicReserveUsd = clamp(10 * 0.2, 1, 10) = 2
spendableCapitalUsd = 8
```

Micin default:
```ts
finalBuyUsd = 3 * 0.7 * 1 = 2.10
```
Lolos, karena `2.10 <= 8`.

Whale default:
```ts
finalBuyUsd = 3 * 1 * 1 = 3.00
```
Juga lolos, karena `3.00 <= 8`.

### 8.2 Wallet $10, open exposure $6

Whale default:
```ts
committedCapitalUsd = 6 + 3 = 9
spendableCapitalUsd = 8
```
Hasil: blocked by capital guard.

### 8.3 Slippage user terlalu tinggi

Jika user Telegram set `3%`:
```ts
requestedSlippageBps = 300
```
- Micin cap `300` -> lolos full `300`
- Whale cap `150` -> dicap ke `150`

## 9. Catatan Penting Biar Tidak Salah Paham

### 9.1 `TOTAL_CAPITAL` bukan wallet live balance
`TOTAL_CAPITAL` dipakai untuk:
- startup validation
- AI context
- max drawdown portfolio rule

Trade live tetap memakai balance wallet Telegram real.

### 9.2 `RESERVE_AMOUNT` bukan reserve runtime utama
Reserve runtime utama adalah:
```ts
dynamicReserveUsd = clamp(balanceUsd * DYNAMIC_RESERVE_RATIO, MIN_RESERVE_USD, MAX_RESERVE_USD)
```

### 9.3 Slot guard dan capital guard itu beda
- Slot guard: jumlah posisi open.
- Capital guard: cukup tidak modal yang bisa dipakai setelah reserve.

### 9.4 Hard fail dan Telegram
Current runtime:
- hard fail tidak masuk radar
- hard fail juga masih bisa tersuppress sepenuhnya dari Telegram

Target semantics:
- hard fail tidak masuk radar
- hard fail boleh mengirim satu terminal `WATCHLIST BLOCKED`

## 10. Yang Paling Berpengaruh ke Hasil

Urutan faktor paling besar ke performa:
1. `MIN_BUY_CONFIDENCE`
2. `ANALYZER_MIN_VOLUME_SURGE`
3. `ANALYZER_MIN_Z_SCORE`
4. `MICIN_MAX_PRICE_IMPACT_PCT`
5. `WHALE_MAX_PRICE_IMPACT_PCT`
6. `POSITION_SIZE_USD`
7. `MICIN_POSITION_SIZE_MULTIPLIER`
8. `DAILY_MAX_LOSS_USD`
9. `MAX_DRAWDOWN_PCT`
10. `AI_CONVICTION_THRESHOLD`

## 11. Saran Tuning Singkat

### 11.1 Kalau terlalu sepi
- turunkan `AI_CONVICTION_THRESHOLD` ke `72`
- atau turunkan `WHALE_SIGNAL_SCORE_FLOOR` ke `40`
- atau longgarkan `ANALYZER_MIN_Z_SCORE` ke `1.3`

### 11.2 Kalau fake pump masih banyak lolos
- naikkan `MIN_BUY_CONFIDENCE` ke `0.65`
- perketat `MICIN_MAX_PRICE_IMPACT_PCT` ke `2.0`
- jangan naikkan cap slippage whale

### 11.3 Kalau wallet kecil
- `POSITION_SIZE_USD = 2.5 - 3`
- `TOTAL_SLOTS = 2`
- `MICIN_POSITION_SIZE_MULTIPLIER = 0.6 - 0.7`

## 12. Ringkasan Satu Baris per Layer

- Discovery: cari token cepat dari WS + polling.
- Quant gate: cek volume, buy pressure, anomaly, velocity.
- Route: token muda masuk micin, token matang masuk whale.
- Safety gate: mint authority, RugCheck, holder concentration, creator risk.
- AI gate: final judge untuk conviction dan size.
- Execution gate: slot, reserve, capital, balance, slippage, price impact.
- Monitoring: trailing, stop loss, partial TP, dev dump, rugpull exit.
- Telegram: bedakan jelas candidate, waiting, rejected, blocked, signal valid, dan execution failed.
