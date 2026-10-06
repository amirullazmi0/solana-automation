/**
 * Membuktikan URL tombol Telegram terbentuk benar dari nilai `config.json` yang sebenarnya.
 *
 * Satu URL rusak membuat Telegram menolak SELURUH pesan dengan 400, jadi ini diperiksa terhadap
 * konfigurasi nyata, bukan terhadap nilai karangan di dalam test.
 */
import { resolveDashboardBase } from '../src/common/dashboard-url';
import { loadRuntimeConfig } from '../src/config/runtime-config';

const MINT = '5tCju6YNxHq5zrA6tGndr6F7TK42mpUFmeE31cSFpump';
const configured = String(loadRuntimeConfig().DASHBOARD_PUBLIC_URL ?? '');
const base = resolveDashboardBase(configured);

console.log('config.json :', JSON.stringify(configured));
console.log('base        :', base ?? '(tidak valid -> tombol tidak muncul)');
console.log('url tombol  :', base ? `${base}/dashboard/?mint=${encodeURIComponent(MINT)}` : '-');

console.log('\nbentuk lain:');
for (const candidate of [
    'msoulmation.apps.arulize.com',
    'https://msoulmation.apps.arulize.com///',
    'http://192.168.1.10:3100',
    'msoulmation',
    'not a url',
    'javascript:alert(1)',
    '',
]) {
    const out = resolveDashboardBase(candidate);
    console.log(`  ${JSON.stringify(candidate).padEnd(40)} -> ${out ?? 'DITOLAK (tombol hilang, pesan tetap terkirim)'}`);
}
process.exit(0);
