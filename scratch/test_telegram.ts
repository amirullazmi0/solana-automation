import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    console.log('Testing Telegram with Bot Token:', token, 'Chat ID:', chatId);
    if (!token || !chatId) {
        console.error('Missing telegram settings in .env');
        return;
    }
    
    try {
        const res = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: '🔔 *Antigravity Diagnostic Test*\nTelegram notifications are working correctly!',
            parse_mode: 'Markdown'
        });
        console.log('Telegram API Response Status:', res.status);
        console.log('Result:', res.data.ok ? 'SUCCESS' : 'FAILED');
    } catch (e) {
        console.error('Telegram Error:', e instanceof Error ? e.message : String(e));
    }
}

main();
