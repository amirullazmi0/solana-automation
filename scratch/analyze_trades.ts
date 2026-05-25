import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const prisma = new PrismaClient();
    try {
        const trades = await prisma.trade.findMany({
            orderBy: { createdAt: 'desc' },
            take: 20
        });

        console.log('================================================================');
        console.log('📊 RECENT TRADES REPORT (Last 20 Trades)');
        console.log('================================================================\n');

        if (trades.length === 0) {
            console.log('No trades found in the database.');
        } else {
            trades.forEach(t => {
                const profitPercent = t.exitPrice ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 : null;
                console.log(`ID: ${t.id} | Token: ${t.symbol || 'UNKNOWN'} (${t.tokenMint})`);
                console.log(`  Status: ${t.status} | Exit Reason: ${t.exitReason || 'N/A'}`);
                console.log(`  Entry Price: $${t.entryPrice.toFixed(8)} | Exit Price: $${t.exitPrice ? t.exitPrice.toFixed(8) : 'N/A'}`);
                console.log(`  Profit (USD): $${t.profitUsd ? t.profitUsd.toFixed(4) : '0.00'} | Profit (%): ${profitPercent ? profitPercent.toFixed(2) + '%' : 'N/A'}`);
                console.log(`  Entry Market Cap: $${t.entryMarketCap ? t.entryMarketCap.toLocaleString() : 'N/A'} | Entry Liquidity: $${t.entryLiquidity ? t.entryLiquidity.toLocaleString() : 'N/A'}`);
                console.log(`  Highest Price: $${t.highestPrice.toFixed(8)} | Trailing Stop Price: $${t.trailingStopPrice.toFixed(8)}`);
                console.log(`  Created At: ${t.createdAt.toISOString()}`);
                console.log('----------------------------------------------------------------');
            });
        }
    } catch (e) {
        console.error('Error fetching trades:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
