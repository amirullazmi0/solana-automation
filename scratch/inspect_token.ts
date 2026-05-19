import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        const failed = await prisma.watchlist.findMany({
            where: { status: 'FAILED' },
            take: 30,
            orderBy: { lastCheckedAt: 'desc' }
        });
        console.log('--- RECENT FAILED WATCHLIST ITEMS ---');
        failed.forEach(f => {
            console.log(`Mint: ${f.tokenMint}, Reason: ${f.reason}, Status: ${f.status}, checks: ${f.checkCount}`);
        });
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
