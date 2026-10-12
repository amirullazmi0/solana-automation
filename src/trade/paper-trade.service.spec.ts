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

/**
 * The simulation must measure the strategy that is actually running.
 *
 * The base config says a 12% stop and a 0.8% trail; a MICIN trade runs an 8% stop and a 4% trail.
 * A paper trade resolving the base values would describe exits the live bot would never have taken,
 * and every conclusion drawn from it would be about an imaginary strategy.
 *
 * The key names are duplicated across the two services on purpose -- PriceMonitorService sits on the
 * money path and the paper service deliberately cannot reference it -- so this is what stops the
 * duplication drifting.
 */
describe('paper exits follow the same rules as live exits', () => {
    const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

    const ROUTE_KEYS = [
        ['MICIN_STOP_LOSS_PERCENT', 'WHALE_STOP_LOSS_PERCENT', 'STOP_LOSS_PERCENT'],
        ['MICIN_TAKE_PROFIT_PERCENT', 'WHALE_TAKE_PROFIT_PERCENT', 'TAKE_PROFIT_PERCENT'],
        ['MICIN_TRAILING_DISTANCE_PERCENT', 'WHALE_TRAILING_DISTANCE_PERCENT', 'TRAILING_DISTANCE_PERCENT'],
    ];

    it('resolves every exit threshold from the same config keys the monitor uses', () => {
        const paper = read('trade/paper-trade.service.ts');
        const monitor = read('price-monitor/price-monitor.service.ts');

        for (const group of ROUTE_KEYS) {
            for (const key of group) {
                expect({ key, paper: paper.includes(key), monitor: monitor.includes(key) }).toEqual({
                    key,
                    paper: true,
                    monitor: true,
                });
            }
        }
    });

    // Falling back to the base config regardless of route is the specific mistake this guards:
    // it looks correct and silently simulates a different stop.
    it('never reads a bare base threshold without a route lookup beside it', () => {
        const paper = read('trade/paper-trade.service.ts');
        for (const [micin, , base] of ROUTE_KEYS) {
            const baseIndex = paper.indexOf(`'${base}'`);
            const micinIndex = paper.indexOf(`'${micin}'`);
            expect({ base, routeAware: micinIndex > -1 && micinIndex < baseIndex }).toEqual({
                base,
                routeAware: true,
            });
        }
    });
});

/**
 * The first paper trade ever recorded closed at -36.56% in 26 seconds, and it was an artefact.
 *
 * `simulatePaperEntry` was given `metadata.priceUsd`, the price the analyzer read at the START of
 * its check -- before RugCheck, the AI calls and the risk queue. Across the 29 live trades that
 * stored both the signal-time feed price and the on-chain fill, the two differ by more than 5% in
 * 17 of them and the feed sits 7.46% above the fill on average. Settling a simulated entry anchored
 * there against the live feed books that gap as P&L, so the simulation lost money the live bot never
 * would have lost.
 *
 * These lock the two halves of the fix: the entry is priced from a fresh read, and the simulation
 * refuses the signals the live chase gate refuses.
 */
describe('paper entries are priced like a live entry', () => {
    const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

    it('prices the entry from a fresh read rather than the signal snapshot', () => {
        const paper = read('trade/paper-trade.service.ts');

        const freshIndex = paper.indexOf('this.fetchPrices([input.tokenMint])');
        const entryIndex = paper.indexOf('simulatePaperEntry({');

        expect({
            fetchesFresh: freshIndex > -1,
            beforeEntry: freshIndex > -1 && freshIndex < entryIndex,
        }).toEqual({ fetchesFresh: true, beforeEntry: true });
    });

    // The specific regression: handing the stale snapshot straight to the entry maths.
    it('never hands the raw signal price to the entry simulation', () => {
        const paper = read('trade/paper-trade.service.ts');
        const call = paper.slice(
            paper.indexOf('simulatePaperEntry({'),
            paper.indexOf('if (!(entry.tokenAmount > 0)) return;'),
        );

        expect(call).toContain('priceUsd: quotePriceUsd');
        expect(call).not.toContain('priceUsd: input.priceUsd');
    });

    it('enforces the same chase limit, from the same config key, as the live buy gate', () => {
        const paper = read('trade/paper-trade.service.ts');
        const live = read('trade/trade.service.ts');

        expect({ paper: paper.includes('MAX_BUY_CHASE_PCT'), live: live.includes('MAX_BUY_CHASE_PCT') }).toEqual({
            paper: true,
            live: true,
        });
        expect(paper).toContain('wouldChasePrice');
    });

    /**
     * The fresh read queues on the shared 500 ms DexScreener lane. Awaited on the buy path it would
     * spend part of the MAX_BUY_SIGNAL_AGE_MS budget (15s in config.json) the live buy has to fit
     * inside, and a simulation that can get a real buy rejected as stale is worse than no
     * simulation at all.
     */
    it('stays off the live buy path', () => {
        const scanner = read('scanner/scanner.service.ts');

        expect(scanner).toContain('void this.recordPaperTrade(');
        expect(scanner).not.toContain('await this.recordPaperTrade(');
    });
});
