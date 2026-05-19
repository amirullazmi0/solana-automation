import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const rpc = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
    console.log('Testing RPC:', rpc);
    const conn = new Connection(rpc, 'confirmed');
    try {
        const slot = await conn.getSlot();
        console.log('Current slot:', slot);
        
        const pkey = process.env.PRIVATE_KEY;
        if (!pkey) {
            console.error('No private key in .env');
            return;
        }
        const wallet = Keypair.fromSecretKey(bs58.decode(pkey));
        console.log('Pubkey derived:', wallet.publicKey.toBase58());
        const balance = await conn.getBalance(wallet.publicKey);
        console.log('Wallet Balance:', balance / 1e9, 'SOL');
    } catch (e) {
        console.error('RPC Error:', e);
    }
}

main();
