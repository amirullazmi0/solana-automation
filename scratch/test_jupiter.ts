import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const jupiterApiKey = process.env.JUPITER_API_KEY || '';
    const baseUrl = 'https://api.jup.ag';
    console.log('Testing Jupiter API with Key:', jupiterApiKey);
    
    try {
        const quoteUrl = `${baseUrl}/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=100`;
        const quoteResponse = await axios.get(quoteUrl, {
            headers: { 'x-api-key': jupiterApiKey }
        });
        const quoteData = quoteResponse.data;
        console.log('Quote fetched successfully.');
        
        const swapUrl = `${baseUrl}/swap/v1/swap`;
        const response = await axios.post(
            swapUrl,
            {
                quoteResponse: quoteData,
                userPublicKey: 'LkYeiJjmgEz3rf45ADbs6gJgD5NDcuRkQ9uLop9Z2Kx',
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 100000, // 100k lamports
            },
            {
                headers: { 
                    'x-api-key': jupiterApiKey 
                }
            }
        );
        console.log('Swap response status:', response.status);
        console.log('Swap transaction length:', response.data.swapTransaction?.length);
    } catch (e) {
        console.error('Jupiter Error:', e.response?.data || e.message);
    }
}

main();
