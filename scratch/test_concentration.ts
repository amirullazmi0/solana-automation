import axios from 'axios';

interface RugCheckHolder {
    address: string;
    owner: string;
    pct: number;
}

interface RugCheckKnownAccount {
    type: string;
    name?: string;
}

async function testToken(tokenMint: string) {
    try {
        console.log(`Checking token: ${tokenMint}`);
        const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, { timeout: 5000 });
        if (!response.data) {
            console.log('No data');
            return;
        }

        const topHolders = (response.data.topHolders as RugCheckHolder[]) || [];
        const knownAccounts = (response.data.knownAccounts as Record<string, RugCheckKnownAccount | undefined>) || {};

        const filteredHolders = topHolders.filter(h => {
            const known = knownAccounts[h.address] || knownAccounts[h.owner];
            const isExcludedType = known && (known.type === 'AMM' || known.type === 'LOCKER');
            const isSystemAccount = h.owner === '11111111111111111111111111111111';
            return !isExcludedType && !isSystemAccount;
        });

        const top10SumPct = filteredHolders.slice(0, 10).reduce((sum: number, h: RugCheckHolder) => sum + (h.pct || 0), 0);
        const safetyIndex = 1 - (top10SumPct / 100);
        const score = response.data.score || 0;
        
        console.log(`Score: ${score}`);
        console.log(`Top 10 Sum Pct: ${top10SumPct.toFixed(2)}%`);
        console.log(`Safety Index: ${safetyIndex.toFixed(4)}`);
        console.log(`Filtered Holders count: ${filteredHolders.length}`);
        console.log('Top 10 details:');
        filteredHolders.slice(0, 10).forEach((h, i) => {
            console.log(`  ${i+1}. Pct: ${h.pct.toFixed(2)}% (Owner: ${h.owner})`);
        });
    } catch (e) {
        console.error(`Error checking ${tokenMint}:`, e.message);
    }
}

async function main() {
    // Let's fetch some boosted tokens on Solana from DexScreener
    try {
        console.log('Fetching boosted tokens from DexScreener...');
        const dsRes = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 5000 });
        const tokens = dsRes.data.slice(0, 5);
        for (const t of tokens) {
            await testToken(t.tokenAddress);
            console.log('------------------------------------');
        }
    } catch (e) {
        console.error('DexScreener fetch failed:', e.message);
    }
}

main();
