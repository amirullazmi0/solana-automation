import { Connection, PublicKey } from '@solana/web3.js';

async function testWss() {
  const connection = new Connection('https://solana-rpc.publicnode.com', {
    wsEndpoint: 'wss://solana-rpc.publicnode.com',
    commitment: 'confirmed'
  });
  const RAYDIUM = new PublicKey('675kRwJGm1MqJCYR6ba8Lde6ygvwtq22U6cC1Fi991S8');

  console.log('Testing onLogs subscription...');
  let logCount = 0;
  
  const subId = connection.onLogs(RAYDIUM, (logs, ctx) => {
    logCount++;
    const isInit = logs.logs.some(l => l.toLowerCase().includes('initialize2'));
    if (isInit) {
        console.log('!!! INITIALIZE 2 FOUND !!!', logs.signature);
    }
  });

  setInterval(() => {
    console.log(`Logs received so far: ${logCount}`);
  }, 10000);

  setTimeout(() => {
    console.log(`Total logs received in 60 seconds: ${logCount}`);
    connection.removeOnLogsListener(subId);
    process.exit(0);
  }, 60000);
}

testWss();
