/**
 * Menjalankan `ZoneDigestService` yang asli terhadap jaringan sungguhan dan mencetak hasilnya.
 *
 * Service-nya di-instansiasi langsung dengan stub ConfigService dan PrismaService, bukan lewat
 * NestFactory, supaya probe ini tidak ikut menghidupkan scanner, price monitor, dan polling
 * Telegram hanya untuk membaca enam harga.
 *
 *   npx ts-node --transpile-only scratch/zone-digest-probe.ts
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandleService } from '../src/dashboard/candle.service';
import { ZoneDigestService } from '../src/dashboard/zone-digest.service';

const configStub = {
    get: (_key: string, fallback?: unknown) => fallback,
} as unknown as ConfigService;

// Watchlist kosong: produksi memang belum membeli apa pun sejak 18 September, jadi ini justru
// kondisi yang sebenarnya, dan memaksa seluruh digest diisi dari feed.
const prismaStub = {
    watchlist: { findMany: async () => [] },
} as unknown as PrismaService;

const fmt = (n: number) => (n >= 1 ? n.toFixed(4) : n.toPrecision(4));

async function main() {
    const candleService = new CandleService(configStub);
    const digest = await new ZoneDigestService(configStub, candleService, prismaStub).build();

    console.log(`dipindai : ${digest.scanned}`);
    console.log(`dilewati : ${digest.skipped.map((s) => `${s.symbol} (${s.why})`).join(', ') || '-'}`);
    console.log(`masuk    : ${digest.entries.length}\n`);

    digest.entries.forEach((e, i) => {
        const rr = e.rewardRisk !== undefined ? `${e.rewardRisk.toFixed(1)}:1` : 'satu sisi';
        console.log(`${i + 1}. ${e.symbol}  ${rr}  $${fmt(e.price)}  [${e.source}]`);
        console.log(
            `   beli ${e.buyZone ? `$${fmt(e.buyZone.low)}-$${fmt(e.buyZone.high)} (${e.buyDistancePct?.toFixed(1)}%, ${e.buyZone.strength})` : 'tidak ada'}`,
        );
        console.log(
            `   jual ${e.sellZone ? `$${fmt(e.sellZone.low)}-$${fmt(e.sellZone.high)} (+${e.sellDistancePct?.toFixed(1)}%, ${e.sellZone.strength})` : 'tidak ada'}`,
        );
        console.log(`   ${e.candleCount} candle · ${e.ageHours?.toFixed(0)}j · $${Math.round(e.liquidityUsd || 0).toLocaleString('en-US')} liq`);
    });

    // Urutan adalah seluruh gunanya report ini. Kalau reward-to-risk tidak menurun, peringkatnya
    // bohong dan baris teratas bukan kandidat terbaik.
    const rrs = digest.entries.map((e) => e.rewardRisk ?? -1);
    const sorted = rrs.every((v, i) => i === 0 || rrs[i - 1] >= v);
    console.log(`\nurutan reward-to-risk menurun: ${sorted ? 'YA' : 'TIDAK — peringkatnya salah'}`);
    process.exit(0);
}

void main();
