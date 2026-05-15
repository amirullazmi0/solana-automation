
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const latest = await prisma.watchlist.findMany({
        orderBy: { id: 'desc' },
        take: 15,
        select: {
            id: true,
            tokenMint: true,
            symbol: true,
            mcap: true,
            status: true,
            reason: true,
            createdAt: true,
            volumeSurge: true,
            priceChange1h: true,
            liquidity: true
        }
    });

    console.log(JSON.stringify(latest, null, 2));
}

main()
    .catch((e) => console.error(e))
    .finally(async () => await prisma.$disconnect());
