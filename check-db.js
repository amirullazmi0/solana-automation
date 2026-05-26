const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
    // Last 12 hours
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000);

    console.log(`\n=== 📋 WATCHLIST (12 jam terakhir, sejak ${since.toISOString().slice(11,19)} UTC) ===\n`);

    const watchlist = await prisma.watchlist.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            symbol: true,
            status: true,
            reason: true,
            checkCount: true,
            mcap: true,
            liquidity: true,
            volScore: true,
            zScore: true,
            createdAt: true,
        },
    });

    console.table(watchlist.map(w => ({
        id: w.id,
        symbol: (w.symbol || '-').slice(0, 12),
        status: w.status,
        reason: (w.reason || '-').slice(0, 22),
        checks: w.checkCount,
        mcap: w.mcap ? Math.round(w.mcap) : 0,
        liq: w.liquidity ? Math.round(w.liquidity) : 0,
        time: w.createdAt.toISOString().slice(11, 19),
    })));

    // Summary
    const pending = watchlist.filter(w => w.status === 'PENDING').length;
    const traded = watchlist.filter(w => w.status === 'TRADED').length;
    const failed = watchlist.filter(w => w.status === 'FAILED').length;
    console.log(`\n📊 12h Summary: Total ${watchlist.length} | PENDING: ${pending} | TRADED: ${traded} | FAILED: ${failed}`);

    // Fail reasons
    const reasons = {};
    watchlist.filter(w => w.status === 'FAILED').forEach(w => {
        const r = w.reason || 'unknown';
        reasons[r] = (reasons[r] || 0) + 1;
    });
    const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    console.log('\n❌ FAIL REASONS (12h):');
    console.table(sorted.map(([reason, count]) => ({ reason, count })));

    // Trades last 12h
    console.log('\n=== 💰 TRADES (12 jam terakhir) ===\n');
    const trades = await prisma.trade.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            symbol: true,
            status: true,
            exitReason: true,
            profitUsd: true,
            entryPrice: true,
            entryMarketCap: true,
            createdAt: true,
        },
    });

    if (trades.length === 0) {
        console.log('⚠️ TIDAK ADA TRADE DALAM 12 JAM TERAKHIR!\n');
    } else {
        console.table(trades.map(t => ({
            id: t.id,
            symbol: t.symbol || '-',
            status: t.status,
            exit: t.exitReason || '-',
            pnl: t.profitUsd ? t.profitUsd.toFixed(2) : '-',
            mcap: t.entryMarketCap ? Math.round(t.entryMarketCap) : 0,
            created: t.createdAt.toISOString().slice(11, 19),
        })));
    }

    // Koin TRADED yang punya metrics bagus tapi tidak jadi trade
    console.log('\n=== 🎯 KOIN POTENSIAL YANG DITOLAK (mcap > 30K, liq > 10K, status FAILED) ===\n');
    const potentials = watchlist.filter(w => 
        w.status === 'FAILED' && 
        w.mcap && w.mcap > 30000 && 
        w.liquidity && w.liquidity > 10000
    );
    console.table(potentials.map(w => ({
        symbol: (w.symbol || '-').slice(0, 12),
        reason: w.reason || '-',
        mcap: Math.round(w.mcap),
        liq: Math.round(w.liquidity),
        vol: w.volScore ? w.volScore.toFixed(3) : '-',
        z: w.zScore ? w.zScore.toFixed(1) : '-',
        time: w.createdAt.toISOString().slice(11, 19),
    })));

    console.log(`Total koin potensial ditolak: ${potentials.length}`);

    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
