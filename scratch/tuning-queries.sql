-- Query penalaan config: dari "apa yang menahan bot" ke "ambang mana yang harus digeser, berapa".
--
-- CATATAN WAKTU, JANGAN DIHAPUS. Kolom DateTime di sini menyimpan UTC polos, sementara `now()` di
-- sesi lu mengembalikan WIB (+7). Memakai `now()` langsung membuat jendela 2 jam terakhir kosong,
-- dan itu pernah membuat kesimpulan "bot-nya mati" diambil dua kali padahal dia hidup. Karena itu
-- setiap perbandingan waktu memakai `(now() AT TIME ZONE 'UTC')`.


-- ============================================================================
-- 1. CORONG: apa yang sebenarnya menahan, 7 hari terakhir
-- ============================================================================
-- Alasan dipecah dari format `stagnant_timeout:<alasan>` supaya penolakan sesungguhnya terlihat,
-- bukan terhitung sebagai "timeout".
SELECT
    CASE
        WHEN reason LIKE 'stagnant_timeout:%' THEN split_part(reason, ':', 2)
        ELSE COALESCE(reason, '(null)')
    END AS alasan,
    COUNT(*) AS jumlah,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS persen
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
GROUP BY 1
ORDER BY jumlah DESC;


-- ============================================================================
-- 2. SEBERAPA JAUH yang ditolak dari ambangnya
-- ============================================================================
-- Ini pertanyaan yang menentukan. "643 ditolak low_metrics" tidak memberi tahu apakah menurunkan
-- MIN_MCAP 20% membuka 5 kandidat atau 500. Persentil menjawabnya.
SELECT
    COUNT(*) AS n,
    ROUND(percentile_cont(0.10) WITHIN GROUP (ORDER BY mcap)::numeric)      AS mcap_p10,
    ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY mcap)::numeric)      AS mcap_p25,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY mcap)::numeric)      AS mcap_p50,
    ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY mcap)::numeric)      AS mcap_p75,
    ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY liquidity)::numeric) AS liq_p25,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY liquidity)::numeric) AS liq_p50,
    ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY liquidity)::numeric) AS liq_p75,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY "volumeSurge")::numeric, 2) AS vsurge_p50,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY "whaleSignalScore")::numeric, 1) AS whale_p50
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
  AND reason LIKE '%low_metrics%';


-- ============================================================================
-- 3. COUNTERFACTUAL: berapa kandidat yang terbuka kalau ambang digeser
-- ============================================================================
-- Hitung langsung, bukan ditebak. Ganti angka di VALUES untuk menguji nilai lain.
WITH kandidat AS (
    SELECT mcap, liquidity
    FROM "Watchlist"
    WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
      AND reason LIKE '%low_metrics%'
      AND mcap IS NOT NULL
      AND liquidity IS NOT NULL
),
ambang (min_mcap, min_liq) AS (
    VALUES (20000, 15000), (15000, 12000), (12000, 10000), (10000, 8000), (8000, 6000)
)
SELECT
    a.min_mcap,
    a.min_liq,
    COUNT(*) FILTER (WHERE k.mcap >= a.min_mcap AND k.liquidity >= a.min_liq) AS lolos,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE k.mcap >= a.min_mcap AND k.liquidity >= a.min_liq)
        / NULLIF(COUNT(*), 0), 1
    ) AS persen_terbuka
FROM ambang a
CROSS JOIN kandidat k
GROUP BY a.min_mcap, a.min_liq
ORDER BY a.min_mcap DESC;


-- ============================================================================
-- 4. UANG: exit mana yang menghasilkan, exit mana yang membakar
-- ============================================================================
-- netProfitUsd, bukan profitUsd: yang kedua belum dikurangi fee, dan fee sekitar 0,0011 SOL per
-- round trip adalah yang membedakan menang tipis dari kalah tipis.
SELECT
    COALESCE("exitReason", '(masih terbuka)') AS exit_reason,
    COUNT(*)                                  AS trade,
    ROUND(SUM("netProfitUsd")::numeric, 2)    AS net_total,
    ROUND(AVG("netProfitUsd")::numeric, 3)    AS net_rata,
    ROUND(100.0 * COUNT(*) FILTER (WHERE "netProfitUsd" > 0) / COUNT(*), 0) AS menang_persen,
    ROUND(AVG("exitTriggerPnlPercent")::numeric, 1) AS pnl_saat_trigger
FROM "Trade"
WHERE mode = 'LIVE'
  AND status = 'CLOSED'
GROUP BY 1
ORDER BY net_total ASC NULLS LAST;


-- ============================================================================
-- 5. STOP LOSS: apakah fast-stop-price sudah bekerja
-- ============================================================================
-- Sebelum perbaikan, stop yang disetel -8% rata-rata tereksekusi di -17,1%. Overshoot diukur di
-- saat TRIGGER, bukan saat fill, jadi ini benar-benar mengukur kecepatan deteksi.
SELECT
    date_trunc('day', "createdAt") AS hari,
    COUNT(*)                       AS trade,
    ROUND(AVG("targetStopLoss")::numeric, 1)          AS sl_disetel,
    ROUND(AVG("exitTriggerPnlPercent")::numeric, 1)   AS sl_terpicu,
    ROUND(AVG("exitTriggerPnlPercent" + "targetStopLoss")::numeric, 1) AS overshoot
FROM "Trade"
WHERE mode = 'LIVE'
  AND "exitReason" = 'STOP_LOSS'
  AND "exitTriggerPnlPercent" IS NOT NULL
  AND "targetStopLoss" IS NOT NULL
GROUP BY 1
ORDER BY hari DESC
LIMIT 14;


-- ============================================================================
-- 6. META: tema mana yang menghasilkan uang
-- ============================================================================
-- Diurut dari yang paling merugi, karena itu yang perlu dimatikan lebih dulu. Sampel di bawah 3
-- trade ditandai: satu trade tidak mencirikan sebuah meta.
SELECT
    COALESCE("metaLabel", '(tanpa label)') AS meta,
    COUNT(*)                                AS trade,
    ROUND(SUM("netProfitUsd")::numeric, 2)  AS net_total,
    ROUND(AVG("netProfitUsd")::numeric, 3)  AS net_per_trade,
    ROUND(100.0 * COUNT(*) FILTER (WHERE "netProfitUsd" > 0) / COUNT(*), 0) AS menang_persen,
    CASE WHEN COUNT(*) < 3 THEN 'sampel terlalu kecil' ELSE '' END AS catatan
FROM "Trade"
WHERE mode = 'LIVE'
  AND status = 'CLOSED'
GROUP BY 1
ORDER BY net_total ASC;


-- ============================================================================
-- 7. UKURAN DAN UMUR: di mana trade yang menang sebenarnya berada
-- ============================================================================
-- Kalau yang menang semuanya di satu bucket likuiditas, ambangnya harus pindah ke sana.
SELECT
    CASE
        WHEN "entryLiquidity" < 15000  THEN 'a. <15k'
        WHEN "entryLiquidity" < 25000  THEN 'b. 15-25k'
        WHEN "entryLiquidity" < 50000  THEN 'c. 25-50k'
        WHEN "entryLiquidity" < 100000 THEN 'd. 50-100k'
        ELSE                                'e. >100k'
    END AS bucket_likuiditas,
    COUNT(*)                               AS trade,
    ROUND(SUM("netProfitUsd")::numeric, 2) AS net_total,
    ROUND(AVG("netProfitUsd")::numeric, 3) AS net_per_trade,
    ROUND(100.0 * COUNT(*) FILTER (WHERE "netProfitUsd" > 0) / COUNT(*), 0) AS menang_persen
FROM "Trade"
WHERE mode = 'LIVE'
  AND status = 'CLOSED'
  AND "entryLiquidity" IS NOT NULL
GROUP BY 1
ORDER BY 1;


-- ============================================================================
-- 8. DENYUT: apakah bot masih memproses sama sekali
-- ============================================================================
-- Dijalankan lebih dulu kalau angka mana pun di atas terlihat kosong. Daftar kosong di sini berarti
-- scanner berhenti; daftar terisi berarti dia hidup dan yang menahan adalah gerbangnya.
SELECT
    date_trunc('hour', "lastCheckedAt") AS jam_utc,
    COUNT(*)                            AS dicek,
    COUNT(*) FILTER (WHERE status = 'PENDING') AS masih_pending
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours'
GROUP BY 1
ORDER BY jam_utc DESC
LIMIT 24;
