const axios = require('axios');

async function main() {
    const mint = 'So11111111111111111111111111111111111111112';
    const jupiterApiKey = 'jup_b8fc81c5557eafa2169c092b3649fbcb0f9c86ea3e0ff66c2e79cd3b283d6885';
    try {
        const response = await axios.get(`https://api.jup.ag/price/v3?ids=${mint}`, {
            headers: { 'x-api-key': jupiterApiKey }
        });
        console.log('Jupiter Price API Response:', JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.error('Error fetching price:', e.message);
    }
}

main();
