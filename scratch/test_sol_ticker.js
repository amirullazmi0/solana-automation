const axios = require('axios');

async function main() {
    const jupiterApiKey = 'jup_b8fc81c5557eafa2169c092b3649fbcb0f9c86ea3e0ff66c2e79cd3b283d6885';
    
    console.log('--- JUPITER WITH SOL TICKER ---');
    try {
        const res = await axios.get(`https://api.jup.ag/price/v3?ids=SOL`, {
            headers: { 'x-api-key': jupiterApiKey }
        });
        console.log(res.data);
    } catch (e) {
        console.error('Jupiter Error:', e.message);
    }
}

main();
