import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        console.log('--- WATCHLIST STATS ---');
        
        // Count statuses
        const statusCounts = await prisma.watchlist.groupBy({
            by: ['status'],
            _count: true
        });
        console.log('Status Counts:', JSON.stringify(statusCounts, null, 2));

        // Count reasons for FAILED
        const failedReasonCounts = await prisma.watchlist.groupBy({
            by: ['reason'],
            where: { status: 'FAILED' },
            _count: true
        });
        console.log('Failed Reasons:', JSON.stringify(failedReasonCounts, null, 2));

        // Get latest 10 PENDING items
        const pendingItems = await prisma.watchlist.findMany({
            where: { status: 'PENDING' },
            orderBy: { lastCheckedAt: 'desc' },
            take: 10
        });
        console.log('Latest 10 PENDING Items:', JSON.stringify(pendingItems, null, 2));

        // Get latest 10 FAILED items
        const failedItems = await prisma.watchlist.findMany({
            where: { status: 'FAILED' },
            orderBy: { lastCheckedAt: 'desc' },
            take: 10
        });
        console.log('Latest 10 FAILED Items:', JSON.stringify(failedItems, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
