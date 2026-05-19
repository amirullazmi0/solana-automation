import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        const trades = await prisma.trade.findMany({
            orderBy: { createdAt: 'desc' }
        });
        console.log('--- ALL TRADES ---');
        console.log(JSON.stringify(trades, null, 4));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
