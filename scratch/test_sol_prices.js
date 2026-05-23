const axios = require('axios');

async function main() {
    const mint = 'So11111111111111111111111111111111111111112';
    const jupiterApiKey = 'jup_b8fc81c5557eafa2169c092b3649fbcb0f9c86ea3e0ff66c2e79cd3b283d6885';
    
    console.log('--- JUPITER ---');
    try {
        const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mint}`, {
            headers: { 'x-api-key': jupiterApiKey }
        });
        console.log(res.data);
    } catch (e) {
        console.error('Jupiter Error:', e.message);
    }

    console.log('\n--- DEXSCREENER ---');
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        console.log(res.data.pairs?.[0]?.priceUsd);
    } catch (e) {
        console.error('DexScreener Error:', e.message);
    }
}

main();
