import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as https from 'https';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    console.log('================================================================');
    console.log('🔍 SOLANA TRADING BOT - MASTER DIAGNOSTIC SYSTEM');
    console.log('================================================================\n');

    // 1. DATABASE & WATCHLIST CHECK
    console.log('--- 1. DATABASE & WATCHLIST STATS ---');
    const prisma = new PrismaClient();
    try {
        const statusCounts = await prisma.watchlist.groupBy({
            by: ['status'],
            _count: true
        });
        console.log('Watchlist Statuses:', JSON.stringify(statusCounts, null, 2));

        const failedReasons = await prisma.watchlist.groupBy({
            by: ['reason'],
            where: { status: 'FAILED' },
            _count: true,
            orderBy: { _count: { reason: 'desc' } }
        });
        console.log('Failed Reasons Summary:', JSON.stringify(failedReasons, null, 2));

        const totalPending = await prisma.watchlist.count({ where: { status: 'PENDING' } });
        console.log(`Total PENDING Items: ${totalPending}`);
        
        if (totalPending > 0) {
            const latestPending = await prisma.watchlist.findMany({
                where: { status: 'PENDING' },
                orderBy: { createdAt: 'desc' },
                take: 3
            });
            console.log('Latest 3 PENDING items:', JSON.stringify(latestPending, null, 2));
        }
    } catch (e) {
        console.error('❌ Database error:', e);
    } finally {
        await prisma.$disconnect();
    }
    console.log('\n----------------------------------------------------------------\n');

    // 2. RPC & WALLET CHECK
    console.log('--- 2. RPC & WALLET STATUS ---');
    const rpcEndpoint = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
    const conn = new Connection(rpcEndpoint, 'confirmed');
    try {
        console.log('RPC Endpoint:', rpcEndpoint.split('?')[0]); // Hide API Key for safety
        const slot = await conn.getSlot();
        console.log(`✅ RPC Connection Successful. Current Slot: ${slot}`);

        const privateKey = process.env.PRIVATE_KEY;
        if (privateKey) {
            const wallet = Connection.prototype ? KeypairFromKey(privateKey) : null;
            if (wallet) {
                const balance = await conn.getBalance(wallet.publicKey);
                console.log(`🔑 Derived Pubkey: ${wallet.publicKey.toBase58()}`);
                console.log(`💰 SOL Balance: ${balance / 1e9} SOL`);
            }
        } else {
            console.log('⚠️ No PRIVATE_KEY found in .env');
        }
    } catch (e) {
        console.error('❌ RPC Check Failed:', e);
    }
    console.log('\n----------------------------------------------------------------\n');

    // 3. JUPITER PRICE API V3 CHECK
    console.log('--- 3. JUPITER PRICE API V3 STATUS ---');
    const jupiterKey = process.env.JUPITER_API_KEY || '';
    const mockMint = 'So11111111111111111111111111111111111111112'; // WSOL
    try {
        console.log('Querying: https://api.jup.ag/price/v3?ids=' + mockMint);
        const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mockMint}`, {
            timeout: 5000,
            headers: { 'x-api-key': jupiterKey }
        });
        console.log('Jupiter Price API v3 Response structure:');
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`❌ Jupiter API v3 Failed: ${msg}`);
    }
    console.log('\n----------------------------------------------------------------\n');

    // 4. RUGCHECK API STATUS
    console.log('--- 4. RUGCHECK API STATUS & SAMPLE CHECK ---');
    const sampleMint = '92e5MqoxHhVMQCmkP5QJ6Cw3t5LoUTEbqLB2uRcypump'; // Sample failed token
    try {
        const url = `https://api.rugcheck.xyz/v1/tokens/${sampleMint}/report`;
        console.log(`Fetching RugCheck report for: ${sampleMint}`);
        const start = Date.now();
        const res = await axios.get(url, { timeout: 8000 });
        const latency = Date.now() - start;
        console.log(`✅ RugCheck API Successful. Latency: ${latency}ms`);
        console.log(`   Risk Score: ${res.data.score || 0}`);
        console.log(`   Creator Address: ${res.data.creator || 'N/A'}`);
        
        const risks = res.data.risks || [];
        console.log(`   Risks Found (${risks.length}):`);
        for (const risk of risks) {
            console.log(`     - [${risk.level.toUpperCase()}] ${risk.name} (${risk.description || ''})`);
        }

        // LP Markets Check
        const markets = res.data.markets || [];
        console.log(`   LP Markets (${markets.length}):`);
        for (const m of markets) {
            console.log(`     - Type: ${m.lpType}, Status: ${m.lpStatus}, Amount: ${m.lpSize || 0}%`);
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`❌ RugCheck API Failed: ${msg}`);
    }
    console.log('\n================================================================');
}

function KeypairFromKey(pkey: string) {
    try {
        const { Keypair } = require('@solana/web3.js');
        return Keypair.fromSecretKey(bs58.decode(pkey));
    } catch {
        return null;
    }
}

main();
