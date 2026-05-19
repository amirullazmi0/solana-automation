import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        const tokenMint = '69aniAWVnZcqPbzeMqN4w2kaYZLryt7ESdj3GuGUpump';
        const trade = await prisma.trade.findFirst({
            where: { tokenMint }
        });
        const watchlist = await prisma.watchlist.findUnique({
            where: { tokenMint }
        });
        console.log('--- TRADE RECORD ---');
        console.log(JSON.stringify(trade, null, 4));
        console.log('--- WATCHLIST RECORD ---');
        console.log(JSON.stringify(watchlist, null, 4));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
