/**
 * Menjalankan SQL BACA-SAJA terhadap database produksi, lewat koneksi Prisma yang sudah ada.
 *
 *   npx ts-node --transpile-only scratch/prod-query.ts scratch/tuning.sql
 *   npx ts-node --transpile-only scratch/prod-query.ts -e "SELECT count(*) FROM \"Trade\""
 *
 * Ini menyentuh basis data bot yang sedang hidup, jadi pagarnya ada di dalam alat, bukan di niat
 * yang menjalankannya:
 *
 * - Hanya satu pernyataan per jalan. Beberapa pernyataan yang dipisah titik koma adalah bentuk
 *   paling umum sebuah SELECT berubah jadi sesuatu yang menulis tanpa disadari pembacanya.
 * - Harus diawali SELECT atau WITH. Apa pun yang lain ditolak sebelum menyentuh jaringan.
 * - Kata kunci penulis dan pengubah skema ditolak secara eksplisit, termasuk ketika muncul di
 *   tengah pernyataan yang diawali SELECT.
 * - `$queryRawUnsafe` dipakai karena SQL-nya datang dari berkas, bukan dari input pengguna. Yang
 *   menjaganya adalah pemeriksaan di atas, bukan parameterisasi yang tidak berlaku di sini.
 */
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

/** Ditolak di mana pun muncul, bukan hanya di awal: satu CTE bisa menyembunyikannya. */
const FORBIDDEN =
    /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|vacuum|reindex|refresh|call|do|set|reset|begin|commit|rollback)\b/i;

function readSql(): string {
    const args = process.argv.slice(2);
    if (args[0] === '-e' && args[1]) return args[1];
    if (!args[0]) throw new Error('Pakai: prod-query.ts <berkas.sql> | -e "<sql>"');
    return readFileSync(args[0], 'utf8');
}

/** Buang komentar sebelum memeriksa, atau kata terlarang bisa bersembunyi di balik `--`. */
function stripComments(sql: string): string {
    return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function assertReadOnly(sql: string): void {
    const bare = stripComments(sql).trim().replace(/;\s*$/, '');

    if (bare.includes(';')) {
        throw new Error('Ditolak: lebih dari satu pernyataan. Jalankan satu per satu.');
    }
    if (!/^\s*(select|with)\b/i.test(bare)) {
        throw new Error('Ditolak: hanya SELECT atau WITH yang diizinkan.');
    }
    const hit = bare.match(FORBIDDEN);
    if (hit) {
        throw new Error(`Ditolak: mengandung kata kunci penulis "${hit[0]}".`);
    }
}

function render(rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0) {
        console.log('(tidak ada baris)');
        return;
    }
    const cols = Object.keys(rows[0]);
    // Date dicetak sebagai UTC eksplisit, bukan lewat String(): penyaji bawaan menempelkan label
    // zona waktu lokal pada nilai yang sebenarnya UTC polos, dan kebingungan itu sudah dua kali
    // membuat kesimpulan salah diambil dari data ini.
    const text = (v: unknown) =>
        v === null || v === undefined
            ? '-'
            : v instanceof Date
              ? v.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
              : String(v);
    const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => text(r[c]).length)));

    console.log(cols.map((c, i) => c.padEnd(width[i])).join('  '));
    console.log(width.map((w) => '-'.repeat(w)).join('  '));
    for (const row of rows) {
        console.log(cols.map((c, i) => text(row[c]).padEnd(width[i])).join('  '));
    }
    console.log(`\n(${rows.length} baris)`);
}

async function main() {
    const sql = readSql();
    assertReadOnly(sql);

    const prisma = new PrismaClient();
    try {
        const rows = (await prisma.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
        // BigInt dari COUNT(*) tidak bisa di-JSON-kan dan merusak pencetakan apa adanya.
        render(
            rows.map((r) =>
                Object.fromEntries(
                    Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]),
                ),
            ),
        );
    } finally {
        await prisma.$disconnect();
    }
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
