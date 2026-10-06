/**
 * Nol zona dari 300 candle adalah klaim yang harus dibuktikan, bukan ditebak.
 *
 * Kalau potongan data yang lebih pendek menghasilkan zona sementara data penuh tidak, berarti logika
 * pembuangan zona memang bekerja dan datanya yang tidak menghormati level. Kalau tidak ada potongan
 * mana pun yang menghasilkan zona, kemungkinan besar portingnya yang salah.
 *
 *   npx ts-node --transpile-only scratch/zone-why.ts <dir-berisi-SYM.json>
 */
import * as fs from 'fs';
import { computeShvedZones, minimumCandles } from '../src/dashboard/shved-zones';

const dir = process.argv[2];
console.log(`minimum candle: ${minimumCandles()}\n`);

for (const sym of ['ABU', 'USEFUL', 'swordcat']) {
    const path = `${dir}/${sym}.json`;
    if (!fs.existsSync(path)) continue;
    const d = JSON.parse(fs.readFileSync(path, 'utf8')) as { candles: Parameters<typeof computeShvedZones>[0] };
    const all = d.candles;
    console.log(`=== ${sym} (${all.length} candle) ===`);

    for (const n of [50, 80, 120, 200, 300]) {
        if (n > all.length) continue;
        const slice = all.slice(-n);
        const cells = [0.3, 0.75, 1.5].map((fuzz) => {
            const z = computeShvedZones(slice, { fuzzFactor: fuzz });
            const s = z.filter((x) => x.type === 'SUPPORT').length;
            const r = z.length - s;
            return `fuzz ${fuzz} -> ${String(z.length).padStart(2)} zona (${s}B/${r}J)`;
        });
        console.log(`  terakhir ${String(n).padStart(3)}:  ${cells.join('   ')}`);
    }
    console.log();
}
