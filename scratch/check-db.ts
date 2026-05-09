import { PrismaClient } from '@prisma/client';

async function checkDb() {
  const prisma = new PrismaClient();
  const trades = await prisma.trade.findMany();
  console.log(`Total trades in DB: ${trades.length}`);
  console.log(trades);
}

checkDb();
