const axios = require('axios');

async function checkPrice(url) {
    try {
        const response = await axios.get(url);
        console.log(`URL: ${url}`);
        console.log('Response:', JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.error(`Error for ${url}:`, e.message);
    }
}

async function main() {
    await checkPrice('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
    await checkPrice('https://api.jup.ag/price/v2?ids=SOL');
}

main();
