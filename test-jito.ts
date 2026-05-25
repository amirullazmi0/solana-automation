import {
    Connection,
    Keypair,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
    PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load .env
dotenv.config();

const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5xCUoS5ncHNZfgXgtRoLmE7UcrK8GqLpL5Ew4w4f',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSka',
    'DfXygSm4jMRu1ZfB33kUStA9GokT6pS6xRkK7wP5x5Xb',
    'ADuUkR4wZQ2dZStKqA4UXXPZ8yJv2QvU8TjL25uJ1w1k',
    'DttWaMuVvZ1KqY6tWf1w9A1hP1m4p2iQ5hZwv3F7m53T',
    '3AVi9Tg9Uo68Yh2Sqw7T9C39n1bY6pQn1E5jZ2pUwv3R',
];

const JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

async function main() {
    console.log('🚀 Memulai Test Jito MEV Bundle...');

    const rpcUrl = process.env.RPC_ENDPOINT;
    const pkBase58 = process.env.PRIVATE_KEY;

    if (!rpcUrl || !pkBase58) {
        throw new Error('Missing RPC_ENDPOINT or PRIVATE_KEY in .env');
    }

    const connection = new Connection(rpcUrl, 'confirmed');
    const wallet = Keypair.fromSecretKey(bs58.decode(pkBase58));

    console.log(`🔑 Wallet Address: ${wallet.publicKey.toBase58()}`);

    // Get blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    console.log(`📦 Recent Blockhash: ${blockhash}`);

    // 1. Buat Tx1 (Simulasi Transaksi Utama)
    console.log('🛠️ Membangun Tx1 (Transaksi Utama)...');
    const tx1Message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wallet.publicKey,
                lamports: 10_000, // 0.00001 SOL
            }),
        ],
    }).compileToV0Message();
    const tx1 = new VersionedTransaction(tx1Message);
    tx1.sign([wallet]);
    console.log('✅ Tx1 Signed');

    // 2. Buat Tx2 (Transaksi Jito Tip)
    console.log('🛠️ Membangun Tx2 (Jito Tip)...');
    const randomTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipLamports = 100_000; // 0.0001 SOL Tip

    const tx2Message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash, // HARUS SAMA DENGAN TX1
        instructions: [
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: new PublicKey(randomTipAccount),
                lamports: tipLamports,
            }),
        ],
    }).compileToV0Message();
    const tx2 = new VersionedTransaction(tx2Message);
    tx2.sign([wallet]);
    console.log(`✅ Tx2 Signed (Tip ${tipLamports / 1e9} SOL to ${randomTipAccount})`);

    // 3. Serialize & Encode ke Base58
    const tx1Base58 = bs58.encode(tx1.serialize());
    const tx2Base58 = bs58.encode(tx2.serialize());

    // 4. Kirim Bundle ke Jito Block Engine
    console.log('🚀 Mengirim Bundle ke Jito Block Engine...');
    const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[tx2Base58, tx1Base58]],
    };

    try {
        const response = await axios.post(JITO_BLOCK_ENGINE_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
        });

        console.log('📩 Jito Response:', response.data);

        if (response.data.error) {
            console.error('❌ Jito Error:', response.data.error);
            return;
        }

        const bundleId = response.data.result;
        console.log(`🎉 Bundle berhasil terkirim! Bundle ID: ${bundleId}`);

        // 5. Polling Konfirmasi Tx1 via RPC
        const tx1Signature = bs58.encode(tx1.signatures[0]);
        console.log(`🔍 Memantau konfirmasi transaksi: https://solscan.io/tx/${tx1Signature}`);

        let confirmed = false;
        let attempts = 0;
        while (!confirmed && attempts < 15) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Tunggu 2 detik
            
            const status = await connection.getSignatureStatus(tx1Signature);
            if (status && status.value && (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized')) {
                console.log(`✅ Transaksi berhasil masuk blok! Status: ${status.value.confirmationStatus}`);
                confirmed = true;
                break;
            } else if (status && status.value && status.value.err) {
                console.error(`❌ Transaksi Gagal di Blockchain:`, status.value.err);
                break;
            }
            console.log(`⏳ Menunggu konfirmasi... (percobaan ${attempts}/15)`);
        }

        if (!confirmed) {
            console.log('⚠️ Transaksi tidak terkonfirmasi dalam 30 detik. Mungkin expired atau Tip terlalu kecil.');
        }

    } catch (error: any) {
        console.error('💥 Error saat mengirim bundle:', error.response?.data || error.message);
    }
}

main().catch(console.error);
