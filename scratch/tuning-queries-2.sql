-- Lanjutan, setelah putaran pertama membalik diagnosisnya.
--
-- Putaran pertama memakai ambang karangan (20k/15k). Ambang ASLI jauh lebih tinggi:
--   MIN_MCAP = 150000, MIN_LIQUIDITY_USD = 30000, MIN_VOLUME_USD = 2000, MIN_BUY_COUNT = 3
-- Median kandidat yang ditolak punya mcap $2.134 dan likuiditas $2.263 — 70x dan 13x di bawahnya.
-- Jadi pertanyaannya bukan lagi "turunkan ambang berapa", tapi "apakah hulunya memang memberi
-- kandidat berukuran layak sama sekali".
--
-- Waktu tetap memakai (now() AT TIME ZONE 'UTC'): kolomnya UTC polos, sesi lu WIB.


-- ============================================================================
-- 9. APAKAH HULU PERNAH MEMBERI KANDIDAT BERUKURAN LAYAK
-- ============================================================================
-- Tanpa memandang alasan tolak. Kalau baris teratas nyaris nol, tidak ada ambang di hilir yang
-- bisa diperbaiki: masalahnya ada di apa yang scanner masukkan, bukan di apa yang analyzer tolak.
SELECT
    CASE
        WHEN mcap IS NULL          THEN 'z. mcap tidak diketahui'
        WHEN mcap >= 150000        THEN 'a. >=150k  (lolos MIN_MCAP sekarang)'
        WHEN mcap >= 50000         THEN 'b. 50-150k'
        WHEN mcap >= 20000         THEN 'c. 20-50k'
        WHEN mcap >= 5000          THEN 'd. 5-20k'
        ELSE                            'e. <5k     (debu)'
    END AS bucket_mcap,
    COUNT(*)                                                   AS jumlah,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)         AS persen,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY liquidity)::numeric) AS liq_median
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
GROUP BY 1
ORDER BY 1;


-- ============================================================================
-- 10. KANDIDAT YANG BENAR-BENAR BERUKURAN LAYAK: kenapa mereka ditolak
-- ============================================================================
-- Hanya yang lolos ambang ukuran sekarang. Inilah peluang nyata yang hilang, dan alasannya di sini
-- adalah yang pantas ditindaklanjuti.
SELECT
    COALESCE(reason, '(null)') AS alasan,
    COUNT(*)                   AS jumlah,
    ROUND(AVG(mcap)::numeric)      AS mcap_rata,
    ROUND(AVG(liquidity)::numeric) AS liq_rata,
    ROUND(AVG("volumeSurge")::numeric, 2) AS vsurge_rata,
    ROUND(AVG("priceChange1h")::numeric, 1) AS chg1h_rata
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
  AND mcap >= 150000
  AND liquidity >= 30000
GROUP BY 1
ORDER BY jumlah DESC;


-- ============================================================================
-- 11. ZERO_LIQUIDITY: menunggu migrasi, atau memang mati
-- ============================================================================
-- 536 dari 1.278 (41,9%) berhenti di sini. Kodenya membedakan pump.fun pra-migrasi — yang pool
-- AMM-nya memang belum terindeks dan layak ditunggu — dari token yang sudah punya pool tapi tetap
-- kosong. Pembagian itu menentukan apakah knob ZERO_LIQUIDITY_* perlu lebih sabar atau tidak.
SELECT
    "isPumpFun",
    COUNT(*)                                   AS jumlah,
    ROUND(AVG("checkCount")::numeric, 1)       AS cek_rata,
    MAX("checkCount")                          AS cek_maks,
    ROUND(AVG(EXTRACT(EPOCH FROM ("lastCheckedAt" - "createdAt")) / 60)::numeric, 1) AS menit_dipantau,
    COUNT(*) FILTER (WHERE liquidity > 0)      AS sempat_punya_likuiditas
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
  AND reason LIKE '%zero_liquidity%'
GROUP BY 1;


-- ============================================================================
-- 12. KANDIDAT TERBAIK YANG LOLOS: apakah ada yang pantas dibeli
-- ============================================================================
-- Dua puluh kandidat berukuran terbesar dalam 7 hari, beserta nasibnya. Kalau daftar ini berisi
-- token yang jelas bagus dan semuanya ditolak, gerbangnya yang salah. Kalau isinya kosong atau
-- jelek semua, hulunya yang salah.
SELECT
    symbol,
    ROUND(mcap::numeric)          AS mcap,
    ROUND(liquidity::numeric)     AS likuiditas,
    ROUND("volumeSurge"::numeric, 2) AS vsurge,
    ROUND("priceChange1h"::numeric, 1) AS chg1h,
    "isPumpFun"                   AS pumpfun,
    status,
    reason,
    "checkCount"                  AS cek,
    to_char("lastCheckedAt", 'MM-DD HH24:MI') AS terakhir_dicek_utc
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '7 days'
  AND mcap IS NOT NULL
ORDER BY mcap DESC
LIMIT 20;


-- ============================================================================
-- 13. SETELAH DEPLOY: tiga gerbang low_metrics yang kini bisa dibedakan
-- ============================================================================
-- Kosong sampai versi dengan pemecahan alasan ter-deploy. Sesudahnya, inilah yang memberi tahu
-- ambang MANA yang harus digeser — selama ini ketiganya memakai satu nama sehingga tidak ada yang
-- bisa disetel dari angkanya.
SELECT
    reason,
    COUNT(*)                       AS jumlah,
    ROUND(AVG(mcap)::numeric)      AS mcap_rata,
    ROUND(AVG(liquidity)::numeric) AS liq_rata
FROM "Watchlist"
WHERE "lastCheckedAt" > (now() AT TIME ZONE 'UTC') - interval '48 hours'
  AND reason LIKE 'low_metrics:%'
GROUP BY 1
ORDER BY jumlah DESC;
