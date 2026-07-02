import {
    TradeService,
    calculateCleanSwapSolAmount,
    calculateFinalBuySizeUsd,
    calculateRealizedSellPnl,
    capSlippageBps,
    evaluateBuyRisk,
    normalizePriceImpactPct,
    resolveJitoMinPositionUsd,
    mergeTradeScaleInPosition,
    resolveSafeSellSolPrice,
    resolveRiskLookbackStart,
    shouldUseJitoForSwap,
    PriceAnomalyError,
    validateSellPrice,
} from './trade.service';
import { computeNetProfitUsd } from '../common/fee-utils';

describe('TradeService calculation helpers', () => {
    describe('normalizePriceImpactPct', () => {
        it('converts fraction-style Jupiter values to percent', () => {
            expect(normalizePriceImpactPct('0.012')).toBeCloseTo(1.2);
        });

        it('keeps percent-style values unchanged', () => {
            expect(normalizePriceImpactPct('1.2')).toBeCloseTo(1.2);
        });

        it('returns a high sentinel for invalid values', () => {
            expect(normalizePriceImpactPct('bad')).toBe(999);
        });
    });

    describe('capSlippageBps', () => {
        it('caps requested slippage by route max', () => {
            expect(capSlippageBps(500, 300)).toBe(300);
            expect(capSlippageBps(500, 150)).toBe(150);
        });

        it('keeps safe requested slippage', () => {
            expect(capSlippageBps(100, 300)).toBe(100);
        });
    });
    describe('validateSellPrice', () => {
        it.each([0.5, 1.0, 2.5, 150])('accepts matching prices at $%s', (price) => {
            expect(validateSellPrice(price, price, 'mint')).toBe(price);
        });

        it('uses Jupiter as tiebreaker for moderate deviation', () => {
            expect(validateSellPrice(2.2, 2.5, 'mint')).toBe(2.5);
        });

        it('throws for large deviation', () => {
            expect(() => validateSellPrice(2.5, 0.3, 'mint')).toThrow(PriceAnomalyError);
        });

        it('throws when both prices are invalid', () => {
            expect(() => validateSellPrice(0, null, 'mint')).toThrow(PriceAnomalyError);
        });
    });

    describe('calculateCleanSwapSolAmount', () => {
        // The Jito tip is paid in a SEPARATE transaction (tx2). rawSolDeltaLamports is read
        // from the swap tx (tx1) only, so the tip is NEVER present in it and must NOT be
        // applied to the clean price math. ATA rent IS in tx1 (removed for price isolation)
        // but is a recoverable deposit, so it is NOT counted as a fee.
        it('BUY: excludes the tip from the clean amount (tip is not in tx1 raw delta)', () => {
            // tx1 delta = swap(1.0 SOL) + networkFee + rent  (no tip)
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_034_280;
            const jitoTipLamports = 1_000_000;
            const rawSolDeltaLamports = 1_000_000_000 + networkFeeLamports + rentDeltaLamports;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
            );

            expect(result.cleanSolAmount).toBe(1); // true SOL spent on tokens (tip excluded)
            expect(result.totalFeesSol).toBe((networkFeeLamports + jitoTipLamports) / 1e9); // 0.001005, rent excluded
        });

        it('SELL: excludes the tip and the rent refund from proceeds/fees', () => {
            // tx1 delta = received(1.0 SOL) - networkFee + rentRefund  (no tip)
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_039_280;
            const jitoTipLamports = 1_000_000;
            const rawSolDeltaLamports = 1_000_000_000 - networkFeeLamports + rentDeltaLamports;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
                'SELL',
            );

            expect(result.cleanSolAmount).toBe(1); // true SOL received (tip + rent refund excluded)
            expect(result.totalFeesSol).toBe((networkFeeLamports + jitoTipLamports) / 1e9); // 0.001005
        });

        it('SELL: adds network fee back to proceeds before subtracting rent (no Jito)', () => {
            const rawSolDeltaLamports = 999_495_000;
            const networkFeeLamports = 505_000;
            const rentDeltaLamports = 0;
            const jitoTipLamports = 0;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
                'SELL',
            );

            expect(result.cleanSolAmount).toBe(1);
            expect(result.totalFeesSol).toBe(0.000505);
        });

        it('BUY no-Jito (tip=0): clean amount unchanged, fees exclude rent', () => {
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_034_280;
            const rawSolDeltaLamports = 1_000_000_000 + networkFeeLamports + rentDeltaLamports;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                0,
            );

            expect(result.cleanSolAmount).toBe(1);
            expect(result.totalFeesSol).toBe(networkFeeLamports / 1e9); // 0.000005
        });

        it('returns null when fees exceed the raw SOL delta', () => {
            const result = calculateCleanSwapSolAmount(100, 50, 50, 1);
            expect(result.cleanSolAmount).toBeNull();
        });
    });

    describe('computeNetProfitUsd', () => {
        it('subtracts fees in USD using solPriceAtEntry', () => {
            // gross +$0.05, fees 0.002 SOL @ $150 = $0.30 -> net -$0.25
            expect(
                computeNetProfitUsd({ profitUsd: 0.05, totalFeesSol: 0.002, solPriceAtEntry: 150 }),
            ).toBeCloseTo(-0.25, 6);
        });
        it('falls back to gross when solPriceAtEntry is missing', () => {
            expect(
                computeNetProfitUsd({ profitUsd: 1.0, totalFeesSol: 0.002, solPriceAtEntry: 0 }),
            ).toBeCloseTo(1.0, 6);
        });
        it('a gross win that is a net loss becomes negative', () => {
            expect(
                computeNetProfitUsd({ profitUsd: 0.01, totalFeesSol: 0.002, solPriceAtEntry: 150 }),
            ).toBeLessThan(0);
        });
    });

    describe('calculateRealizedSellPnl', () => {
        it('treats actual SOL loss as a loss even when token USD price would look profitable', () => {
            const pnl = calculateRealizedSellPnl({
                solSpent: 0.0315,
                solReceived: 0.03,
                entrySolPrice: 75.56,
                sellSolPrice: 75.56,
            });

            expect(pnl.solProfitPercent).toBeCloseTo(-4.7619, 4);
            expect(pnl.usdProfitPercent).toBeCloseTo(-4.7619, 4);
            expect(pnl.usdReceived).toBeLessThan(pnl.usdSpent);
        });

        it('uses entry SOL price as conservative fallback when live SOL price is unavailable', () => {
            const safePrice = resolveSafeSellSolPrice(0, 75.56);
            const pnl = calculateRealizedSellPnl({
                solSpent: 0.0315,
                solReceived: 0.03,
                entrySolPrice: 75.56,
                sellSolPrice: safePrice.solPrice,
            });

            expect(safePrice.source).toBe('entry_fallback');
            expect(pnl.usdReceived).toBeCloseTo(0.03 * 75.56, 6);
            expect(pnl.usdProfitPercent).toBeLessThan(0);
        });
    });
    describe('mergeTradeScaleInPosition', () => {
        it('merges scale-in buys into a weighted average cost basis', () => {
            const merged = mergeTradeScaleInPosition({
                existingAmountInSol: 0.02,
                existingEntryPriceSol: 0.0004,
                existingEntryValueUsd: 1.5,
                existingSolPriceAtEntry: 75,
                existingHighestPriceSol: 0.0005,
                existingTotalFeesSol: 0.001,
                fillAmountInSol: 0.03,
                fillEntryPriceSol: 0.0006,
                fillEntryValueUsd: 2.25,
                fillSolPriceUsd: 75,
                fillActualTokenAmount: 50,
                fillTotalFeesSol: 0.002,
            });

            expect(merged.mergedAmountInSol).toBeCloseTo(0.05, 10);
            expect(merged.mergedEntryValueUsd).toBeCloseTo(3.75, 10);
            expect(merged.mergedSolPriceAtEntry).toBeCloseTo(75, 10);
            expect(merged.mergedTotalFeesSol).toBeCloseTo(0.003, 10);
            expect(merged.totalTokenAmount).toBeCloseTo(100, 10);
            expect(merged.mergedEntryPriceSol).toBeCloseTo(0.0005, 10);
            expect(merged.mergedHighestPriceSol).toBeCloseTo(0.0006, 10);
        });
    });

    describe('Jito size gate', () => {
        it('skips Jito below the configured minimum notional', () => {
            expect(
                shouldUseJitoForSwap({
                    useJitoConfigured: true,
                    retryCount: 0,
                    swapNotionalUsd: 6.99,
                    jitoMinPositionUsd: 7,
                }),
            ).toBe(false);
        });

        it('allows Jito at or above the configured minimum notional on first attempt only', () => {
            expect(
                shouldUseJitoForSwap({
                    useJitoConfigured: true,
                    retryCount: 0,
                    swapNotionalUsd: 7,
                    jitoMinPositionUsd: 7,
                }),
            ).toBe(true);
            expect(
                shouldUseJitoForSwap({
                    useJitoConfigured: true,
                    retryCount: 1,
                    swapNotionalUsd: 10,
                    jitoMinPositionUsd: 7,
                }),
            ).toBe(false);
        });

        it('falls back to the safe $7 threshold when config is invalid', () => {
            expect(resolveJitoMinPositionUsd('bad')).toBe(7);
        });
    });
    describe('calculateFinalBuySizeUsd', () => {
        it('applies route and AI multipliers', () => {
            expect(calculateFinalBuySizeUsd(3, 0.7, 0.5)).toBeCloseTo(1.05);
            expect(calculateFinalBuySizeUsd(3, 1, 1)).toBeCloseTo(3);
        });

        it('clamps unsafe multipliers', () => {
            expect(calculateFinalBuySizeUsd(3, 0, 5)).toBeCloseTo(0.3);
        });
    });

    describe('resolveRiskLookbackStart', () => {
        it('uses the newer value between manual baseline and consecutive lookback', () => {
            const nowMs = Date.parse('2026-06-28T12:00:00Z');
            const oldBaseline = new Date('2026-06-27T00:00:00Z');

            expect(resolveRiskLookbackStart(oldBaseline, 3, nowMs)?.toISOString()).toBe(
                '2026-06-28T09:00:00.000Z',
            );
        });

        it('uses manual baseline when it is newer than the lookback window', () => {
            const nowMs = Date.parse('2026-06-28T12:00:00Z');
            const freshBaseline = new Date('2026-06-28T11:00:00Z');

            expect(resolveRiskLookbackStart(freshBaseline, 3, nowMs)?.toISOString()).toBe(
                '2026-06-28T11:00:00.000Z',
            );
        });
    });
    describe('evaluateBuyRisk', () => {
        it('allows when all guards disabled', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: -999, consecutiveLosses: 10, totalRealizedPnlUsd: -9999 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 0,
                },
                100,
                1000,
            );
            expect(res.allowed).toBe(true);
        });

        it('blocks when disabledUntil is in the future', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: 0, consecutiveLosses: 0, totalRealizedPnlUsd: 0 },
                {
                    disabledUntilMs: 2000,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 0,
                },
                100,
                1000,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('disabled_until');
        });

        it('blocks on daily max loss', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: -50, consecutiveLosses: 0, totalRealizedPnlUsd: 0 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 20,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 0,
                },
                100,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('daily_max_loss');
        });

        it('blocks on consecutive losses', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: 0, consecutiveLosses: 3, totalRealizedPnlUsd: 0 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 3,
                    maxDrawdownPct: 0,
                },
                100,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('max_consecutive_losses');
        });

        it('blocks on max drawdown pct', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: 0, consecutiveLosses: 0, totalRealizedPnlUsd: -11 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 10,
                },
                100,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('max_drawdown');
        });
    });
});

describe('TradeService withdraw guard', () => {
    function createWithdrawGuardService(options: {
        withdrawalsEnabled?: string;
        allowedChatIds?: string;
        walletPublicKey?: string | null;
        signerPublicKey?: string;
    }) {
        const service = Object.create(TradeService.prototype) as any;
        service.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() };
        service.configService = {
            get: jest.fn((key: string) => {
                if (key === 'WITHDRAWALS_ENABLED') return options.withdrawalsEnabled ?? 'false';
                if (key === 'WITHDRAW_ALLOWED_CHAT_IDS') return options.allowedChatIds ?? '';
                if (key === 'WITHDRAWAL_RESERVE_SOL') return '0.005';
                return undefined;
            }),
        };
        service.telegramWorkspace = {
            getChatById: jest.fn().mockResolvedValue({
                id: 1,
                chatId: '123',
                walletVault: options.walletPublicKey
                    ? { publicKey: options.walletPublicKey }
                    : null,
            }),
            getWalletKeypair: jest.fn().mockResolvedValue({
                publicKey: { toBase58: () => options.signerPublicKey ?? 'signer-wallet' },
            }),
        };
        service.prismaService = { telegramWithdrawal: { create: jest.fn() } };
        return service;
    }

    it('blocks before creating a withdrawal when withdrawals are disabled', async () => {
        const service = createWithdrawGuardService({
            withdrawalsEnabled: 'false',
            allowedChatIds: '123',
            walletPublicKey: 'wallet-a',
        });

        const result = await service.sendSolanaToAddress('123', '', 'usd', 1);

        expect(result).toEqual({ success: false, message: 'Withdrawals are disabled.' });
        expect(service.prismaService.telegramWithdrawal.create).not.toHaveBeenCalled();
    });

    it('blocks before creating a withdrawal when chat has no connected wallet', async () => {
        const service = createWithdrawGuardService({
            withdrawalsEnabled: 'true',
            allowedChatIds: '123',
            walletPublicKey: null,
        });

        const result = await service.sendSolanaToAddress('123', '', 'usd', 1);

        expect(result).toEqual({
            success: false,
            message: 'Wallet is not connected for this Telegram chat.',
        });
        expect(service.prismaService.telegramWithdrawal.create).not.toHaveBeenCalled();
    });

    it('blocks before creating a withdrawal when signer wallet does not match chat wallet', async () => {
        const service = createWithdrawGuardService({
            withdrawalsEnabled: 'true',
            allowedChatIds: '123',
            walletPublicKey: 'wallet-a',
            signerPublicKey: 'wallet-b',
        });

        const result = await service.sendSolanaToAddress(
            '123',
            '11111111111111111111111111111111',
            'usd',
            1,
        );

        expect(result).toEqual({
            success: false,
            message: 'Wallet ownership validation failed for this Telegram chat.',
        });
        expect(service.prismaService.telegramWithdrawal.create).not.toHaveBeenCalled();
    });
});