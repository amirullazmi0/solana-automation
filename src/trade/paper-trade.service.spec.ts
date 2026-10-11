import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The safety property this feature rests on, asserted against the source rather than behaviour.
 *
 * A PAPER row describes tokens that were never bought. If any path that sells were to pick one up,
 * the bot would try to sell a position that does not exist — spending real fees, and worse,
 * potentially selling an unrelated balance. Today every selling path filters `mode: 'LIVE'`, which
 * makes paper rows invisible to them.
 *
 * That filter is one word long and easy to delete while refactoring something else. Behaviour tests
 * would not catch its removal unless they happened to have a paper row open at the time; this does.
 */
describe('paper trades cannot be sold', () => {
    const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

    /**
     * Source with comments removed.
     *
     * The checks below look for names that must not appear, and the doc comments explaining why
     * they must not appear naturally contain them. Scanning raw text makes an accurate explanation
     * fail the test it is describing.
     */
    const codeOf = (file: string) =>
        read(file)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const SELLING_PATHS = [
        'price-monitor/price-monitor.service.ts',
        'trade/trade.service.ts',
        'reporting/reporting.service.ts',
    ];

    it('has the selling paths to check', () => {
        for (const file of SELLING_PATHS) {
            expect({ file, length: read(file).length > 0 }).toEqual({ file, length: true });
        }
    });

    // Every query that loads open positions in order to act on them must scope itself to LIVE.
    // An unscoped `status: 'OPEN'` lookup would sweep paper rows in with the real ones.
    it('scopes every open-position lookup to LIVE', () => {
        for (const file of SELLING_PATHS) {
            const text = codeOf(file);
            const unscoped = [...text.matchAll(/where:\s*\{\s*status:\s*'OPEN'[^}]*\}/g)]
                .map((m) => m[0])
                .filter((clause) => !clause.includes("mode: 'LIVE'"))
                // A lookup pinned to one id is already scoped: it can only reload a row the caller
                // has in hand, which came from a LIVE-filtered query in the first place.
                .filter((clause) => !clause.includes('id:'));

            expect({ file, unscoped }).toEqual({ file, unscoped: [] });
        }
    });

    // Structural, not a promise: the service has no way to reach a wallet or a swap.
    it('keeps the paper service away from the money path', () => {
        const text = codeOf('trade/paper-trade.service.ts');
        const forbidden: Array<[string, RegExp]> = [
            // Its own name ends in TradeService, so the match has to exclude that.
            ['TradeService', /(?<!Paper)TradeService/],
            ['Keypair', /\bKeypair\b/],
            ['sendTransaction', /sendTransaction/],
            ['signTransaction', /signTransaction/],
            ['JupiterLimiter', /JupiterLimiter/],
            ['jup.ag', /jup\.ag/],
            ['walletVault', /walletVault/],
        ];

        for (const [name, pattern] of forbidden) {
            expect({ name, found: pattern.test(text) }).toEqual({ name, found: false });
        }
    });

    // Capital is the scarce thing. A simulation that occupied a slot would block a trade that
    // could have spent real money, which inverts the point of running one.
    it('never occupies a real slot', () => {
        expect(codeOf('trade/paper-trade.service.ts')).toContain('slotNumber: 0');
    });

    // Paper and live P&L must come from one definition, or a comparison between them is measuring
    // two different things and the fee drag silently disappears from one side.
    it('computes profit through the same fee definition as a live trade', () => {
        expect(codeOf('trade/paper-trade.service.ts')).toContain('computeNetProfitUsd');
    });
});
