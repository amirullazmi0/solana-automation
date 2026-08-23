/** Calls each configured model for real. A rejected model id or parameter makes shadow mode
 *  silently collect nothing, so this must be run before trusting the config. */
import 'dotenv/config';
import axios from 'axios';

const KEY = process.env.OPENAI_API_KEY || '';
const BASE = process.env.AI_BASE_URL || 'https://api.openai.com/v1';

async function probe(label: string, body: Record<string, unknown>) {
    const t0 = Date.now();
    try {
        const res = await axios.post(`${BASE}/chat/completions`, {
            messages: [
                { role: 'system', content: 'Reply with JSON: {"ok":true}' },
                { role: 'user', content: 'ping' },
            ],
            response_format: { type: 'json_object' },
            ...body,
        }, { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        const content = res.data?.choices?.[0]?.message?.content;
        console.log(`  OK    ${label.padEnd(46)} ${String(Date.now() - t0).padStart(6)}ms  ${String(content).slice(0, 40)}`);
    } catch (e) {
        const err = e as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
        const status = err.response?.status ?? '-';
        const msg = err.response?.data?.error?.message || err.message || 'unknown';
        console.log(`  GAGAL ${label.padEnd(46)} ${String(Date.now() - t0).padStart(6)}ms  [${status}] ${msg.slice(0, 90)}`);
    }
}

async function main() {
    if (!KEY) { console.log('OPENAI_API_KEY kosong'); return; }
    console.log('=== apakah tiap konfigurasi model benar-benar jalan? ===\n');
    await probe('gpt-4o-mini + temperature 0.1', { model: 'gpt-4o-mini', temperature: 0.1 });
    await probe('gpt-5.6-luna + reasoning_effort none', { model: 'gpt-5.6-luna', reasoning_effort: 'none' });
    await probe('gpt-5.6-luna (tanpa param apa pun)', { model: 'gpt-5.6-luna' });
    await probe('gpt-5.6-luna + temperature 0.1', { model: 'gpt-5.6-luna', temperature: 0.1 });
    await probe('gpt-5-nano (pembanding murah)', { model: 'gpt-5-nano' });
}
void main();
