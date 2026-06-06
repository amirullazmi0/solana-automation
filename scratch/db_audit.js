const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const [watchlist, trades, creators] = await Promise.all([
    prisma.watchlist.count(),
    prisma.trade.count(),
    prisma.creatorProfile.count(),
  ]);

  console.log('counts', { watchlist, trades, creators });

  const watchlistByStatus = await prisma.watchlist.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  console.log('watchlist_by_status', watchlistByStatus);

  const tradeByStatusMode = await prisma.trade.groupBy({
    by: ['status', 'mode'],
    _count: { _all: true },
  });
  console.log('trade_by_status_mode', tradeByStatusMode);

  const pendingNotChecked30m = await prisma.watchlist.count({
    where: {
      status: 'PENDING',
      lastCheckedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
    },
  });
  console.log('pending_not_checked_30m', pendingNotChecked30m);

  const topFailedReasons = await prisma.watchlist.groupBy({
    by: ['reason'],
    where: { status: 'FAILED' },
    _count: { reason: true },
    orderBy: { _count: { reason: 'desc' } },
    take: 15,
  });
  console.log('top_failed_reasons', topFailedReasons);

  const highestCheckCounts = await prisma.watchlist.findMany({
    orderBy: { checkCount: 'desc' },
    take: 10,
    select: { tokenMint: true, symbol: true, status: true, checkCount: true, lastCheckedAt: true, createdAt: true },
  });
  console.log('top_check_count', highestCheckCounts);

  const creatorStats = await prisma.creatorProfile.aggregate({
    _count: { _all: true },
    _avg: { riskScore: true },
    _max: { riskScore: true },
  });
  const blacklistedCount = await prisma.creatorProfile.count({ where: { isBlacklisted: true } });
  console.log('creator_stats', { ...creatorStats, blacklistedCount });

  const liquidityZeros = await prisma.watchlist.count({ where: { liquidity: 0 } });
  const liquidityNull = await prisma.watchlist.count({ where: { liquidity: null } });
  const mcapPresentButLiquidityZero = await prisma.watchlist.count({
    where: { mcap: { gt: 0 }, liquidity: 0 },
  });
  console.log('watchlist_liquidity', { liquidityZeros, liquidityNull, mcapPresentButLiquidityZero });

  // Postgres-only: table sizes (best-effort; requires basic pg_catalog access)
  try {
    const sizes = await prisma.$queryRawUnsafe(`
      SELECT
        relname AS table,
        pg_total_relation_size(quote_ident(relname)) AS total_bytes,
        pg_relation_size(quote_ident(relname)) AS table_bytes,
        pg_total_relation_size(quote_ident(relname)) - pg_relation_size(quote_ident(relname)) AS index_bytes
      FROM pg_class
      WHERE relkind = 'r'
        AND relname IN ('Trade','Watchlist','CreatorProfile')
      ORDER BY total_bytes DESC;
    `);
    console.log('table_sizes_bytes', sizes);
  } catch (e) {
    console.log('table_sizes_bytes_error', e?.message || String(e));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
