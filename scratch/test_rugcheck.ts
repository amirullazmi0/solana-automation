import axios from 'axios';

async function main() {
    try {
        const tokenMint = '69aniAWVnZcqPbzeMqN4w2kaYZLryt7ESdj3GuGUpump';
        const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`);
        console.log('knownAccounts:', res.data.knownAccounts);
        
        console.log('\nTop 10 Holders Detailed:');
        res.data.topHolders.slice(0, 10).forEach((h: any, i: number) => {
            const known = res.data.knownAccounts[h.address] || res.data.knownAccounts[h.owner];
            console.log(`${i+1}. Owner: ${h.owner}, Pct: ${h.pct.toFixed(2)}%, Known:`, known);
        });
    } catch (e) {
        console.error(e);
    }
}

main();
