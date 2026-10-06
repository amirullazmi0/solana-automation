/**
 * Seberapa sering setengah-lebar ATR melampaui harga itu sendiri?
 *
 * Kalau `fu = atr/2 * fuzz` lebih besar dari `low`, zonanya lebih lebar dari seluruh harga token dan
 * batas bawahnya jatuh di bawah nol. Menjepitnya ke nol akan menyimpan zona yang tidak berarti;
 * membuangnya akan kehilangan zona yang mungkin masih berguna. Keputusannya butuh angka.
 */
import * as fs from 'fs';
import { Candle, computeShvedZones } from '../src/dashboard/shved-zones';

const dir = process.argv[2];
const ATR_PERIOD = 7;

for (const sym of ['ABU', 'USEFUL', 'swordcat']) {
    const path = `${dir}/${sym}.json`;
    if (!fs.existsSync(path)) continue;
    const c: Candle[] = JSON.parse(fs.readFileSync(path, 'utf8')).candles;

    // ATR seperti di modulnya: SMA dari True Range periode 7.
    let worst = 0;
    let over = 0;
    let n = 0;
    for (let i = ATR_PERIOD; i < c.length; i += 1) {
        let sum = 0;
        for (let j = i - ATR_PERIOD + 1; j <= i; j += 1) {
            const prev = c[j - 1];
            sum += Math.max(
                c[j].high - c[j].low,
                Math.abs(c[j].high - prev.close),
                Math.abs(c[j].low - prev.close),
            );
        }
        const fu = (sum / ATR_PERIOD / 2) * 0.75;
        const ratio = fu / c[i].low;
        worst = Math.max(worst, ratio);
        if (ratio >= 1) over += 1;
        n += 1;
    }

    const zones = computeShvedZones(c);
    const negative = zones.filter((z) => z.low <= 0).length;
    console.log(
        `${sym.padEnd(10)} zona=${String(zones.length).padStart(2)}  low<=0: ${negative}  ` +
            `fu/low terburuk=${worst.toFixed(3)}  bar dengan fu>=low: ${over}/${n}`,
    );
}
