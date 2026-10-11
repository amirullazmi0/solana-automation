-- Satu query, satu tempel, satu tabel hasil.
--
-- Menggantikan dua berkas query terpisah. Semua bagian dinormalkan ke bentuk yang sama
-- (bagian / baris / jumlah / detail) supaya bisa dibaca sekali jalan tanpa menjalankan sepuluh
-- perintah dan mencocokkan hasilnya sendiri.
--
-- CATATAN WAKTU, JANGAN DIHAPUS. Kolom DateTime menyimpan UTC polos sementara `now()` di sesi lu
-- mengembalikan WIB (+7). Memakai `now()` langsung membuat jendela beberapa jam terakhir kosong,
-- dan itu pernah dua kali membuat kesimpulan "bot-nya mati" diambil padahal dia hidup.

WITH
-- Satu definisi jendela untuk semua bagian, supaya angkanya bisa dibandingkan satu sama lain.
batas AS (
    SELECT
        (now() AT TIME ZONE 'UTC') - interval '7 days'  AS tujuh_hari,
        (now() AT TIME ZONE 'UTC') - interval '48 hours' AS dua_hari,
        (now() AT TIME ZONE 'UTC') - interval '24 hours' AS sehari
),
w AS (
    SELECT * FROM "Watchlist", batas WHERE "lastCheckedAt" > batas.tujuh_hari
),
t AS (
    SELECT * FROM "Trade" WHERE status = 'CLOSED'
),

-- 1. Apa yang menahan. Alasan dipecah dari `stagnant_timeout:<alasan>`, atau blocker sebenarnya
--    ikut terhitung sebagai timeout.
corong AS (
    SELECT
        CASE
            WHEN reason LIKE 'stagnant_timeout:%' THEN split_part(reason, ':', 2)
            ELSE COALESCE(reason, '(null)')
        END AS baris,
        COUNT(*) AS jumlah,
        ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS persen
    FROM w GROUP BY 1
),

-- 2. Apakah hulu memberi kandidat berukuran layak sama sekali. Kalau bucket teratas nyaris nol,
--    tidak ada ambang di hilir yang bisa diperbaiki.
ukuran AS (
    SELECT
        CASE
            WHEN mcap IS NULL   THEN 'f. mcap tidak diketahui'
            WHEN mcap >= 150000 THEN 'a. >=150k (lolos MIN_MCAP)'
            WHEN mcap >= 50000  THEN 'b. 50-150k'
            WHEN mcap >= 20000  THEN 'c. 20-50k'
            WHEN mcap >= 5000   THEN 'd. 5-20k'
            ELSE                     'e. <5k (debu)'
        END AS baris,
        COUNT(*) AS jumlah,
        ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS persen,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY liquidity)::numeric) AS liq_median
    FROM w GROUP BY 1
),

-- 3. Kandidat yang BENAR-BENAR lolos ambang ukuran: inilah peluang nyata yang hilang.
layak AS (
    SELECT
        COALESCE(reason, '(null)') AS baris,
        COUNT(*) AS jumlah,
        ROUND(AVG("volumeSurge")::numeric, 2) AS vsurge,
        ROUND(AVG(liquidity)::numeric) AS liq
    FROM w WHERE mcap >= 150000 AND liquidity >= 30000 GROUP BY 1
),

-- 4. Gerbang low_metrics yang kini bisa dibedakan. Kosong sampai versi pemecah alasan ter-deploy.
gerbang AS (
    SELECT reason AS baris, COUNT(*) AS jumlah, ROUND(AVG(liquidity)::numeric) AS liq
    FROM "Watchlist", batas
    WHERE "lastCheckedAt" > batas.dua_hari AND reason LIKE 'low_metrics:%'
    GROUP BY 1
),

-- 5. Uang per exit. netProfitUsd, bukan profitUsd: fee ~0,0011 SOL per round trip adalah yang
--    membedakan menang tipis dari kalah tipis di ukuran posisi ini.
uang_exit AS (
    SELECT
        mode || ' / ' || COALESCE("exitReason", '(tanpa alasan)') AS baris,
        COUNT(*) AS jumlah,
        ROUND(SUM("netProfitUsd")::numeric, 2) AS net,
        ROUND(100.0 * COUNT(*) FILTER (WHERE "netProfitUsd" > 0) / NULLIF(COUNT(*), 0)) AS menang
    FROM t GROUP BY 1
),

-- 6. Meta mana yang merugi. Diurut dari paling merugi: itu yang perlu dimatikan lebih dulu.
uang_meta AS (
    SELECT
        mode || ' / ' || COALESCE("metaLabel", '(tanpa label)') AS baris,
        COUNT(*) AS jumlah,
        ROUND(SUM("netProfitUsd")::numeric, 2) AS net,
        ROUND(100.0 * COUNT(*) FILTER (WHERE "netProfitUsd" > 0) / NULLIF(COUNT(*), 0)) AS menang
    FROM t GROUP BY 1
),

-- 7. Di bucket likuiditas mana trade yang menang berada. Kalau semuanya di satu bucket, ambangnya
--    pindah ke sana, bukan sekadar diturunkan.
uang_liq AS (
    SELECT
        CASE
            WHEN "entryLiquidity" IS NULL   THEN 'e. tidak diketahui'
            WHEN "entryLiquidity" < 15000   THEN 'a. <15k'
            WHEN "entryLiquidity" < 50000   THEN 'b. 15-50k'
            WHEN "entryLiquidity" < 100000  THEN 'c. 50-100k'
            ELSE                                 'd. >100k'
        END AS baris,
        COUNT(*) AS jumlah,
        ROUND(SUM("netProfitUsd")::numeric, 2) AS net,
        ROUND(100.0 * COUNT(*) FILTER (WHERE "netProfitUsd" > 0) / NULLIF(COUNT(*), 0)) AS menang
    FROM t GROUP BY 1
),

-- 8. Apakah fast-stop-price bekerja. exitTriggerPnlPercent direkam saat TRIGGER, bukan saat fill,
--    jadi ini mengukur kecepatan deteksi, bukan slippage.
stop AS (
    SELECT
        mode AS baris,
        COUNT(*) AS jumlah,
        ROUND(AVG("targetStopLoss")::numeric, 1) AS disetel,
        ROUND(AVG("exitTriggerPnlPercent")::numeric, 1) AS terpicu
    FROM t
    WHERE "exitReason" = 'STOP_LOSS'
      AND "exitTriggerPnlPercent" IS NOT NULL
      AND "targetStopLoss" IS NOT NULL
    GROUP BY 1
),

-- 9. Denyut. Kosong di sini berarti scanner berhenti; terisi berarti dia hidup dan gerbangnya yang
--    menahan. Dibaca lebih dulu kalau bagian mana pun di atas terlihat aneh.
denyut AS (
    SELECT
        to_char(date_trunc('hour', "lastCheckedAt"), 'MM-DD HH24:00') AS baris,
        COUNT(*) AS jumlah
    FROM "Watchlist", batas
    WHERE "lastCheckedAt" > batas.sehari
    GROUP BY 1 ORDER BY 1 DESC LIMIT 6
)

SELECT bagian, baris, jumlah, detail FROM (
    SELECT 1 AS urut, '1. CORONG 7h' AS bagian, baris, jumlah,
           persen || '%' AS detail FROM corong
    UNION ALL
    SELECT 2, '2. UKURAN KANDIDAT 7h', baris, jumlah,
           persen || '% - liq median $' || COALESCE(liq_median::text, '-') FROM ukuran
    UNION ALL
    SELECT 3, '3. LAYAK UKURAN TAPI DITOLAK', baris, jumlah,
           'vsurge ' || COALESCE(vsurge::text, '-') || ' - liq $' || COALESCE(liq::text, '-') FROM layak
    UNION ALL
    SELECT 4, '4. GERBANG low_metrics 48j', baris, jumlah,
           'liq rata $' || COALESCE(liq::text, '-') FROM gerbang
    UNION ALL
    SELECT 5, '5. P&L PER EXIT', baris, jumlah,
           'net $' || COALESCE(net::text, '0') || ' - menang ' || COALESCE(menang::text, '-') || '%' FROM uang_exit
    UNION ALL
    SELECT 6, '6. P&L PER META', baris, jumlah,
           'net $' || COALESCE(net::text, '0') || ' - menang ' || COALESCE(menang::text, '-') || '%' FROM uang_meta
    UNION ALL
    SELECT 7, '7. P&L PER LIKUIDITAS', baris, jumlah,
           'net $' || COALESCE(net::text, '0') || ' - menang ' || COALESCE(menang::text, '-') || '%' FROM uang_liq
    UNION ALL
    SELECT 8, '8. STOP LOSS', baris, jumlah,
           'disetel ' || COALESCE(disetel::text, '-') || '% - terpicu ' || COALESCE(terpicu::text, '-') || '%' FROM stop
    UNION ALL
    SELECT 9, '9. DENYUT 24j', baris, jumlah, '' FROM denyut
) hasil
ORDER BY urut, jumlah DESC, baris;
