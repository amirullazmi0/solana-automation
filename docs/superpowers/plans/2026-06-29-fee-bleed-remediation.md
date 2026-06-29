# Fee-Bleed Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the bot from selling at gross gains that are actually net losses after fees, and make all profit/PnL numbers tell the truth net-of-fees.

**Architecture:** Three classes of fix, in priority order. (P0) Correctness + behavior that directly stops the bleed: fix the Jito-tip phantom-profit accounting bug, disable Jito for sub-$3 trades (the dominant fixed cost), and raise the runner/break-even stop floor above true break-even. (P1) Make reporting, win/loss, and risk circuit-breakers net-of-fees so losers stop reading as wins and the safety brakes actually trip; complete the fee-drag estimate. (P2) Config tuning + dead-code cleanup. Each task is independently shippable, reversible, and config-gated where feasible.

**Tech Stack:** NestJS + TypeScript, Prisma (Postgres), `@solana/web3.js`, Jupiter swap API, Jito bundles. Tests via Jest (`*.spec.ts`).

## Global Constraints

These facts are the basis of every threshold below. Copy them into your reasoning for each task.

- **Active config is `config.json`** (loaded with HIGHER priority than `.env`). Relevant live values: `POSITION_SIZE_USD=3`, `MICIN_POSITION_SIZE_MULTIPLIER=0.7` (→ $2.10 effective MICIN), `WHALE_POSITION_SIZE_MULTIPLIER=1`, `USE_JITO=true`, `JITO_TIP_SOL=0.001`, `MIN_NET_EXIT_PROFIT_PERCENT=3`, `TRAILING_DISTANCE_PERCENT=1.5`, `MICIN_TRAILING_ACTIVATION_PERCENT=12`, `MICIN_TRAILING_DISTANCE_PERCENT=6`, `WHALE_TRAILING_ACTIVATION_PERCENT=8`, `WHALE_TRAILING_DISTANCE_PERCENT=3.5`, `TAKE_PROFIT_PERCENT=15`, `MICIN_TAKE_PROFIT_PERCENT=25`, `WHALE_TAKE_PROFIT_PERCENT=18`.
- **Break-even (gross gain just to recover fees), WITH Jito:** ~11–13% on a $3 position, ~15–19% on a $2.10 MICIN position. Dominated by the FLAT Jito tip: 0.001 SOL × 2 legs ≈ $0.30 round-trip @ ~$150/SOL = 10% of $3, 14% of $2.10 — does **not** shrink with position size.
- **Break-even WITHOUT Jito (priority-fee path):** ~5–9% (priority fee ~$0.05–0.15 + DEX ~0.5% + slippage). This is why disabling Jito on tiny positions is the highest-leverage economic fix.
- **SOL price is assumed ~$150**; all `%` break-evens scale inversely with SOL price.
- **Money-safety (non-negotiable):**
  - Never gate a SAFETY exit (`STOP_LOSS`, `PANIC_SELL`, `DEV_DUMP`, `RUGPULL`, `AI_HEALTH_CRITICAL`) behind a minimum-profit floor. Those must always be free to fire.
  - The `profitUsd` DB column stays GROSS (audit trail). Netting is computed from already-stored fields (`totalFeesSol`, `solPriceAtEntry`) — no DB migration.
  - Validate behavioral changes on the existing dry-run path (`tradeDryRun`) and/or against 2–3 real historical on-chain transactions before running live.
  - Prefer config flags so every change is reversible by editing `config.json`.
- **Verify-before-done:** a task is complete only when its test passes AND `npm run build` is green. Do not claim a behavioral fix works live without dry-run or on-chain evidence.

---

## File / Change Map

| File | Responsibility | Tasks |
|------|----------------|-------|
| `src/trade/trade.service.ts` | swap execution, fee math, sell/PnL bookkeeping, risk metrics | 1, 2, 3, 4, 5 |
| `src/price-monitor/price-monitor.service.ts` | exit decisions, trailing/break-even floor, fee-drag guard | 3, 5, 6, 7 |
| `src/reporting/reporting.service.ts` | daily P&L summary, win-rate display | 4 |
| `config.json` | live runtime thresholds | 2, 3, 5, 6 |
| `src/trade/trade.service.spec.ts` | unit tests for pure fee/PnL helpers | 1, 4 |

---

## Task 1 (P0): Fix the Jito-tip phantom-profit accounting bug

**Why:** `calculateCleanSwapSolAmount` adjusts the swap's clean SOL amount by the Jito tip, but the tip is paid in a **separate transaction (tx2)** while `rawSolDeltaLamports` is read from **tx1 only** (`getActualSwapDetails` fetches `txid = signatures[0]` = the swap tx). The tip is therefore never present in `rawSolDelta`, so subtracting it on BUY / adding it on SELL fabricates a phantom gain of ~one tip per leg. This understates `entryPrice`, overstates exit proceeds, makes every gross threshold (`profitPercent`) misfire early, **and** corrupts the very `entryValueUsd` the fee-aware guard relies on. Also fixes the secondary bug where the recoverable ATA rent deposit is miscounted as a fee.

**Files:**
- Modify: `src/trade/trade.service.ts:77-94` (`calculateCleanSwapSolAmount`)
- Test: `src/trade/trade.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `calculateCleanSwapSolAmount(rawSolDeltaLamports, networkFeeLamports, rentDeltaLamports, jitoTipLamports, side)` — UNCHANGED signature; corrected internal math. Returns `{ cleanSolAmount: number | null, totalFeesSol: number }`.

- [ ] **Step 1: Write the failing test** — add to `src/trade/trade.service.spec.ts` (import the exported function at top: `import { calculateCleanSwapSolAmount } from './trade.service';`)

```typescript
describe('calculateCleanSwapSolAmount (phantom-tip fix)', () => {
  const NET = 5_000;          // network fee lamports (tx1 base+priority fee)
  const RENT = 2_039_280;     // ATA rent deposit/refund lamports
  const TIP = 1_000_000;      // 0.001 SOL Jito tip (paid in tx2, NOT in rawSolDelta)

  it('BUY: clean amount excludes the tip (tip is not in tx1 raw delta)', () => {
    // tx1 wallet delta = swapIn(0.02) + networkFee + rent = 22_044_280
    const raw = 20_000_000 + NET + RENT;
    const { cleanSolAmount, totalFeesSol } = calculateCleanSwapSolAmount(raw, NET, RENT, TIP, 'BUY');
    expect(cleanSolAmount).toBeCloseTo(0.02, 9);        // true SOL spent on tokens
    expect(totalFeesSol).toBeCloseTo((NET + TIP) / 1e9, 12); // network + tip, NOT rent
  });

  it('SELL: clean amount excludes the tip and the rent refund', () => {
    // tx1 wallet delta = received(0.025) - networkFee + rentRefund = 27_034_280
    const raw = 25_000_000 - NET + RENT;
    const { cleanSolAmount, totalFeesSol } = calculateCleanSwapSolAmount(raw, NET, RENT, TIP, 'SELL');
    expect(cleanSolAmount).toBeCloseTo(0.025, 9);       // true SOL received
    expect(totalFeesSol).toBeCloseTo((NET + TIP) / 1e9, 12); // rent refund NOT counted as fee
  });

  it('no-Jito (tip=0): clean amount unchanged, fees exclude rent', () => {
    const raw = 20_000_000 + NET + RENT;
    const { cleanSolAmount, totalFeesSol } = calculateCleanSwapSolAmount(raw, NET, RENT, 0, 'BUY');
    expect(cleanSolAmount).toBeCloseTo(0.02, 9);
    expect(totalFeesSol).toBeCloseTo(NET / 1e9, 12);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npm test -- trade.service`
Expected: the BUY case fails (old code returns `0.019`, not `0.02`) and `totalFeesSol` cases fail (old includes rent).

- [ ] **Step 3: Apply the fix** — replace the body of `calculateCleanSwapSolAmount` (currently lines 84-93):

```typescript
// BEFORE
    const totalFeeLamports = networkFeeLamports + jitoTipLamports;
    const cleanLamports =
        side === 'SELL'
            ? rawSolDeltaLamports + totalFeeLamports - rentDeltaLamports
            : rawSolDeltaLamports - totalFeeLamports - rentDeltaLamports;

    return {
        cleanSolAmount: cleanLamports > 0 ? cleanLamports / 1_000_000_000 : null,
        totalFeesSol: (totalFeeLamports + Math.max(rentDeltaLamports, 0)) / 1_000_000_000,
    };
```

```typescript
// AFTER
    // rawSolDeltaLamports comes from tx1 (the swap) only. The Jito tip is paid in a
    // SEPARATE transaction (tx2) and is therefore NOT present in rawSolDeltaLamports,
    // so it must NOT be applied to the price math here. ATA rent IS in tx1's delta,
    // so it is still removed to isolate the true swap SOL amount.
    const cleanLamports =
        side === 'SELL'
            ? rawSolDeltaLamports + networkFeeLamports - rentDeltaLamports
            : rawSolDeltaLamports - networkFeeLamports - rentDeltaLamports;

    // Fee accounting: network fee + Jito tip are real costs. ATA rent is a recoverable
    // deposit (refunded when the ATA closes on sell), so it nets to ~zero over a round
    // trip and is NOT counted as a fee on either leg.
    const totalFeesSol = (networkFeeLamports + jitoTipLamports) / 1_000_000_000;

    return {
        cleanSolAmount: cleanLamports > 0 ? cleanLamports / 1_000_000_000 : null,
        totalFeesSol,
    };
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm test -- trade.service`
Expected: PASS (all three cases).

- [ ] **Step 5: Validate against reality before trusting it** — pick 2–3 recent LIVE trades from the DB and confirm the recomputed `entryPrice`/proceeds match the on-chain tx1 SOL delta (the tip should no longer appear in the price). Note: historical rows already written with the old math will differ from new rows — that is expected; do not back-fill.

Run: `npm run build`
Expected: build green.

- [ ] **Step 6: Commit**

```bash
git add src/trade/trade.service.ts src/trade/trade.service.spec.ts
git commit -m "fix(trade): stop double-counting Jito tip in clean swap amount (phantom profit)"
```

**Risk:** Changes `entryPrice`/`profitUsd` for all FUTURE trades (more accurate, slightly lower apparent profit). Historical rows are inconsistent with new ones — acceptable, but any analytics comparing old vs new must account for it. Medium risk, correctness-critical.
**Rollback:** revert the single function; pure change, no state migration.

---

## Task 2 (P0): Disable Jito for trades below $3 (configurable)

**Why (user directive):** The flat 0.001 SOL Jito tip is ~10–14% of a $2–3 position and is the dominant reason break-even is so high. For sub-$3 notional, skip the bundle and use the normal priority-fee path (priority fee is captured correctly in `tx.meta.fee`, so this path is also free of the Task 1 phantom). This is the single highest-leverage economic fix for small positions.

**Files:**
- Modify: `config.json` (add `JITO_MIN_POSITION_USD`)
- Modify: `src/trade/trade.service.ts:1643-1644` (gate `useJito` on notional)
- Modify: `src/trade/trade.service.ts:1241-1252` (pass position notional on the SELL leg so it is gated too)

**Interfaces:**
- Consumes: `buyAmountUSD` param of `executeJupiterSwap` (already exists, line 1509); `this.positionSizeUSD`.
- Produces: behavior — `useJito` is false whenever the swap notional `< JITO_MIN_POSITION_USD`.

- [ ] **Step 1: Add the config key** — `config.json`, after `"JITO_TIP_SOL": 0.001,` (line 70):

```json
  "JITO_TIP_SOL": 0.001,
  "JITO_MIN_POSITION_USD": 3,
```

- [ ] **Step 2: Gate `useJito` on notional** — `src/trade/trade.service.ts`, replace lines 1643-1644:

```typescript
// BEFORE
            const useJitoConfigured = this.configService.get<string>('USE_JITO') === 'true';
            const useJito = useJitoConfigured && retryCount === 0;
```

```typescript
// AFTER
            const useJitoConfigured = this.configService.get<string>('USE_JITO') === 'true';
            const jitoMinPositionUsd = Number.parseFloat(
                this.configService.get<string>('JITO_MIN_POSITION_USD') || '3',
            );
            const swapNotionalUsd = buyAmountUSD ?? this.positionSizeUSD;
            const jitoAllowedForSize =
                !Number.isFinite(jitoMinPositionUsd) || swapNotionalUsd >= jitoMinPositionUsd;
            const useJito = useJitoConfigured && retryCount === 0 && jitoAllowedForSize;
            if (useJitoConfigured && !jitoAllowedForSize) {
                this.logger.log(
                    `[Jupiter] Skipping Jito for small ${side} notional ` +
                        `$${swapNotionalUsd.toFixed(2)} < $${jitoMinPositionUsd} (avoids fixed tip drag).`,
                );
            }
```

- [ ] **Step 3: Gate the SELL leg too** — `src/trade/trade.service.ts`, in the SELL call to `executeJupiterSwap` (lines 1241-1252), change the 5th argument from `undefined` to the position's USD notional so the gate above sees the real size:

```typescript
// BEFORE  (5th arg is buyAmountUSD)
            } = await this.executeJupiterSwap(
                trade.tokenMint,
                'So11111111111111111111111111111111111111112',
                amountInLamports,
                'SELL',
                undefined,
                0,
                sellSlippage,
                sellPriorityFee,
                activeWallet,
                tradeDryRun,
            );
```

```typescript
// AFTER
            } = await this.executeJupiterSwap(
                trade.tokenMint,
                'So11111111111111111111111111111111111111112',
                amountInLamports,
                'SELL',
                trade.entryValueUsd ?? undefined, // notional for Jito-size gate (NOT used for SELL pricing)
                0,
                sellSlippage,
                sellPriorityFee,
                activeWallet,
                tradeDryRun,
            );
```

> NOTE: `buyAmountUSD` is only read for BUY pricing (line 1618, inside `if (side === 'BUY')`) and the retry passthrough — passing it on a SELL affects only the new Jito-size gate, never the sell price. For a runner (post partial-TP) `entryValueUsd` is already halved, so the runner sell is also correctly gated.

- [ ] **Step 4: Verify on dry-run** — run the bot (or the dry-run path) with a MICIN ($2.10) and a $3 trade. Confirm the log shows `Skipping Jito` for the $2.10 buy AND its sell, and does NOT skip for the $3 standard trade. Confirm no `[Jito] Bundle` lines for the skipped trades.

Run: `npm run build`
Expected: build green.

- [ ] **Step 5: Commit**

```bash
git add config.json src/trade/trade.service.ts
git commit -m "feat(trade): skip Jito bundle for trades below JITO_MIN_POSITION_USD ($3)"
```

**Risk:** Without a Jito bundle, swaps lose MEV/bundle landing assurance and rely on priority fee — land rate may drop for tiny trades under congestion. The retry path already falls back to direct-send (line 1665), so behavior is consistent with existing retry handling. Medium risk; fully reversible by raising/zeroing `JITO_MIN_POSITION_USD` or setting it to 0.
**Rollback:** set `"JITO_MIN_POSITION_USD": 0` in `config.json` (no redeploy of code needed).

---

## Task 3 (P0): Raise the runner / zero-loss stop floor above true break-even

**Why:** After a partial take-profit, the runner half's stop is hard-coded to `entryPrice * 1.02` (+2% gross) in two places. +2% is far below break-even, so the 50% runner leg routinely exits net-negative. Replace the magic `1.02` with a configurable break-even-aware floor.

**Files:**
- Modify: `config.json` (add `RUNNER_BREAKEVEN_FLOOR_PERCENT`)
- Modify: `src/trade/trade.service.ts:1291-1294` (runner stop after partial TP)
- Modify: `src/price-monitor/price-monitor.service.ts:849-853` (zero-loss floor)

**Interfaces:**
- Consumes: `RUNNER_BREAKEVEN_FLOOR_PERCENT` from config.
- Produces: runner/zero-loss stop = `entryPrice * (1 + RUNNER_BREAKEVEN_FLOOR_PERCENT/100)`.

- [ ] **Step 1: Add the config key** — `config.json`, after `RUNNER_TRAILING_DISTANCE_MULTIPLIER` (line 31):

```json
  "RUNNER_TRAILING_DISTANCE_MULTIPLIER": 2,
  "RUNNER_BREAKEVEN_FLOOR_PERCENT": 8,
```

> Default 8% is above the no-Jito small-trade break-even (~5–9%). If you keep Jito ON for ≥$3 trades, raise toward ~13% so the runner floor clears their ~11–13% break-even. Tune during review.

- [ ] **Step 2: Fix the runner stop after partial TP** — `src/trade/trade.service.ts`, replace lines 1291-1294:

```typescript
// BEFORE
                    const runnerStopPrice =
                        exitReason === 'PARTIAL_TAKE_PROFIT'
                            ? trade.entryPrice * 1.02
                            : trade.trailingStopPrice;
```

```typescript
// AFTER
                    const runnerFloorPercent = Number.parseFloat(
                        this.configService.get<string>('RUNNER_BREAKEVEN_FLOOR_PERCENT') || '8',
                    );
                    const runnerStopPrice =
                        exitReason === 'PARTIAL_TAKE_PROFIT'
                            ? trade.entryPrice * (1 + (Number.isFinite(runnerFloorPercent) ? runnerFloorPercent : 8) / 100)
                            : trade.trailingStopPrice;
```

- [ ] **Step 3: Fix the zero-loss floor** — `src/price-monitor/price-monitor.service.ts`, replace lines 849-853 (the `ZERO-LOSS PROTECTION` block):

```typescript
// BEFORE
            // 🛡️ ZERO-LOSS PROTECTION: Hanya kunci profit minimal +2% (untuk cover fee) jika koin sudah terbang >= 15%
            if (profitPercent >= 15) {
                const breakEvenPlus = trade.entryPrice * 1.02;
                newTrailingStop = Math.max(newTrailingStop, breakEvenPlus);
            }
```

```typescript
// AFTER
            // 🛡️ BREAK-EVEN PROTECTION: lock a floor that actually covers round-trip fees,
            // not a cosmetic +2%. Uses the fee-aware estimate when available, else config.
            if (profitPercent >= 15) {
                const feeDragPercent = this.estimateFeeDragPercent(trade);
                const marginPercent = this.getNumberConfig('BREAKEVEN_MARGIN_PERCENT', 2);
                const configFloorPercent = this.getNumberConfig('RUNNER_BREAKEVEN_FLOOR_PERCENT', 8);
                const floorPercent = Math.max(feeDragPercent + marginPercent, configFloorPercent);
                const breakEvenPlus = trade.entryPrice * (1 + floorPercent / 100);
                newTrailingStop = Math.max(newTrailingStop, breakEvenPlus);
            }
```

> `estimateFeeDragPercent` and `getNumberConfig` already exist on this service (lines 494, and the `getNumberConfig` helper used at 516). If `BREAKEVEN_MARGIN_PERCENT` is absent it defaults to 2.

- [ ] **Step 4: Sanity-check the math** — for a $2.10 no-Jito MICIN runner: floor ≈ max(feeDrag~6 + 2, 8) = 8% → runner can't lock below +8% gross. For a $3 Jito runner (after Task 1): floor ≈ max(~10 + 2, 8) = 12% → locks ≥ +12%. Both clear break-even.

Run: `npm run build`
Expected: build green.

- [ ] **Step 5: Commit**

```bash
git add config.json src/trade/trade.service.ts src/price-monitor/price-monitor.service.ts
git commit -m "fix(exit): raise runner/zero-loss stop floor to a fee-aware break-even level"
```

**Risk:** A runner that stalls just above the new floor exits a touch earlier than before; downside is bounded to 50% of position and is the intended trade-off (clear fees before "winning"). Low-medium risk.
**Rollback:** set `RUNNER_BREAKEVEN_FLOOR_PERCENT` back toward 2 in `config.json`.

---

## Task 4 (P1): Make PnL, win/loss, and risk circuit-breakers net-of-fees

**Why:** `profitUsd` is stored GROSS (price delta only); fees live in a separate `totalFeesSol` column that is never subtracted. So a +$0.01-gross/−$0.30-fee trade is logged as a WIN, resets the consecutive-loss counter, and the `DAILY_MAX_LOSS_USD` / `MAX_DRAWDOWN_PCT` / `MAX_CONSECUTIVE_LOSSES` breakers under-count real losses and fail to trip. Net the numbers using already-stored fields — no migration. The gross column stays as the audit trail.

**Files:**
- Modify: `src/trade/trade.service.ts` (add exported `computeNetProfitUsd`; net the risk metrics; net the win calc)
- Modify: `src/reporting/reporting.service.ts:1582-1607` (net the daily summary)
- Test: `src/trade/trade.service.spec.ts`

**Interfaces:**
- Produces: `computeNetProfitUsd(trade: { profitUsd, totalFeesSol, solPriceAtEntry }): number` = `gross − totalFeesSol × solPriceAtEntry` (falls back to gross when `solPriceAtEntry` is missing/invalid).

- [ ] **Step 1: Write the failing test** — add to `src/trade/trade.service.spec.ts` (extend the import: `import { calculateCleanSwapSolAmount, computeNetProfitUsd } from './trade.service';`)

```typescript
describe('computeNetProfitUsd', () => {
  it('subtracts fees in USD using solPriceAtEntry', () => {
    // gross +$0.05, fees 0.002 SOL @ $150 = $0.30 -> net -$0.25
    expect(computeNetProfitUsd({ profitUsd: 0.05, totalFeesSol: 0.002, solPriceAtEntry: 150 }))
      .toBeCloseTo(-0.25, 6);
  });
  it('falls back to gross when solPriceAtEntry is missing', () => {
    expect(computeNetProfitUsd({ profitUsd: 1.0, totalFeesSol: 0.002, solPriceAtEntry: 0 }))
      .toBeCloseTo(1.0, 6);
  });
  it('a gross win that is a net loss becomes negative', () => {
    expect(computeNetProfitUsd({ profitUsd: 0.01, totalFeesSol: 0.002, solPriceAtEntry: 150 }))
      .toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `npm test -- trade.service`
Expected: FAIL — `computeNetProfitUsd` is not defined.

- [ ] **Step 3: Add the helper** — `src/trade/trade.service.ts`, near the other exported helpers (e.g. just after `calculateCleanSwapSolAmount`, around line 94):

```typescript
export function computeNetProfitUsd(
    trade: { profitUsd?: number | null; totalFeesSol?: number | null; solPriceAtEntry?: number | null },
): number {
    const gross = Number(trade.profitUsd ?? 0);
    const feesSol = Number(trade.totalFeesSol ?? 0);
    const solPrice = Number(trade.solPriceAtEntry ?? 0);
    if (!Number.isFinite(gross)) return 0;
    if (!Number.isFinite(solPrice) || solPrice <= 0 || !Number.isFinite(feesSol)) return gross;
    return gross - feesSol * solPrice;
}
```

- [ ] **Step 4: Net the risk metrics** — `src/trade/trade.service.ts`, in `getBuyRiskMetrics` replace the two `aggregate` calls and the consecutive-loss loop (lines 543-572) so they reduce net values. Replace the `Promise.all` block + the derivations:

```typescript
// BEFORE: dailyAgg / totalAgg via prisma.aggregate({ _sum: { profitUsd } }), recentClosed selects { profitUsd }
//         dailyRealizedPnlUsd = dailyAgg._sum.profitUsd ?? 0; ... if (p < 0) consecutiveLosses++
```

```typescript
// AFTER
        const feeSelect = { profitUsd: true, totalFeesSol: true, solPriceAtEntry: true } as const;
        const [dailyRows, totalRows, recentClosed] = await Promise.all([
            this.prismaService.trade.findMany({
                where: { status: 'CLOSED', mode: 'LIVE', updatedAt: { gte: effectiveDailyStart } },
                select: feeSelect,
            }),
            this.prismaService.trade.findMany({ where: baseWhere, select: feeSelect }),
            maxConsecutiveLosses > 0
                ? this.prismaService.trade.findMany({
                      where: { ...consecutiveWhere, ...routeWhere },
                      orderBy: { updatedAt: 'desc' },
                      take: Math.min(maxConsecutiveLosses, 50),
                      select: feeSelect,
                  })
                : Promise.resolve([] as Array<{ profitUsd: number | null; totalFeesSol: number | null; solPriceAtEntry: number | null }>),
        ]);

        const dailyRealizedPnlUsd = dailyRows.reduce((s, t) => s + computeNetProfitUsd(t), 0);
        const totalRealizedPnlUsd = totalRows.reduce((s, t) => s + computeNetProfitUsd(t), 0);

        let consecutiveLosses = 0;
        if (maxConsecutiveLosses > 0) {
            for (const t of recentClosed) {
                if (computeNetProfitUsd(t) < 0) consecutiveLosses++;
                else break;
            }
        }
```

> The result-set sizes are bounded (intraday closed trades / `take ≤ 50`), so replacing `aggregate` with `findMany`+reduce is acceptable. Verify `totalFeesSol` and `solPriceAtEntry` exist in the Prisma `Trade` model (they are already read at `estimateFeeDragPercent`).

- [ ] **Step 5: Net the win calc** — `src/trade/trade.service.ts:2554-2559` (`getWinRateForChat`):

```typescript
// BEFORE
        const trades = await this.prismaService.trade.findMany({
            where: { telegramChatId: chatRecord.id, status: 'CLOSED', mode: 'LIVE' },
            select: { profitUsd: true },
        });
        const total = trades.length;
        const wins = trades.filter((trade) => (trade.profitUsd || 0) > 0).length;
```

```typescript
// AFTER
        const trades = await this.prismaService.trade.findMany({
            where: { telegramChatId: chatRecord.id, status: 'CLOSED', mode: 'LIVE' },
            select: { profitUsd: true, totalFeesSol: true, solPriceAtEntry: true },
        });
        const total = trades.length;
        const wins = trades.filter((trade) => computeNetProfitUsd(trade) > 0).length;
```

- [ ] **Step 6: Net the daily summary** — `src/reporting/reporting.service.ts`. Import the helper (`import { computeNetProfitUsd } from '../trade/trade.service';`), ensure the `findMany` near line 1564 selects `totalFeesSol` and `solPriceAtEntry`, then replace lines 1582-1595:

```typescript
// AFTER
            const net = (t: { profitUsd?: number | null; totalFeesSol?: number | null; solPriceAtEntry?: number | null }) =>
                computeNetProfitUsd(t);
            const totalPnl = trades.reduce((sum, t) => sum + net(t), 0);
            const wins = trades.filter((t) => net(t) > 0).length;
            const losses = trades.filter((t) => net(t) <= 0).length;
            const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0';
            const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
            const bestTrade = trades.reduce((best, t) => (net(t) > net(best) ? t : best), trades[0]);
            const worstTrade = trades.reduce((worst, t) => (net(t) < net(worst) ? t : worst), trades[0]);
```

Then update the message lines that print `bestTrade.profitUsd` / `worstTrade.profitUsd` (1606-1607) to `net(bestTrade)` / `net(worstTrade)` so the displayed amounts are net too.

- [ ] **Step 7: Run tests + build**

Run: `npm test -- trade.service && npm run build`
Expected: PASS + green build.

- [ ] **Step 8: Commit**

```bash
git add src/trade/trade.service.ts src/reporting/reporting.service.ts src/trade/trade.service.spec.ts
git commit -m "feat(reporting/risk): compute PnL, win/loss, and breakers net-of-fees"
```

**Risk:** Reporting/labeling + risk-breaker sensitivity change; NO trading-execution-path change. Breakers will now trip sooner (correctly). Low risk. Confirm partial-sell rows don't double-count fees (each leg increments `totalFeesSol`; `profitUsd` accumulates per leg — the helper nets the totals, which is correct at the row level).
**Rollback:** revert; gross columns are untouched so no data loss.

---

## Task 5 (P1): Complete the fee-drag estimate and raise the net floor

**Why:** `estimateFeeDragPercent` captures the Jito tips (the dominant cost) but omits the DEX/AMM pool fee (~0.5% round-trip) and all slippage, and uses a `0.00001 SOL` sell-network-fee constant that is 50–500× too low. So `MIN_NET_EXIT_PROFIT_PERCENT=3` can still pass net-negative exits on small positions. Add the missing terms and raise the floor.

**Files:**
- Modify: `src/price-monitor/price-monitor.service.ts:494-521` (`estimateFeeDragPercent`)
- Modify: `config.json` (`MIN_NET_EXIT_PROFIT_PERCENT`, new `DEX_FEE_ROUNDTRIP_PERCENT`, `ESTIMATED_SELL_NETWORK_FEE_SOL`)

- [ ] **Step 1: Add a DEX-fee term** — `src/price-monitor/price-monitor.service.ts`, in `estimateFeeDragPercent` after computing `totalEstimatedFeesUsd` (line 519), add a percentage-of-position DEX/slippage allowance:

```typescript
// AFTER (replace the final return at line 521)
        const dexAndSlippagePercent = this.getNumberConfig('DEX_FEE_ROUNDTRIP_PERCENT', 1.0);
        return (totalEstimatedFeesUsd / entryValueUsd) * 100 + dexAndSlippagePercent;
```

- [ ] **Step 2: Raise the constants + floor** — `config.json`:

```json
  "MIN_NET_EXIT_PROFIT_PERCENT": 5,
  "ESTIMATED_SELL_NETWORK_FEE_SOL": 0.0005,
  "DEX_FEE_ROUNDTRIP_PERCENT": 1.0
```

> `DEX_FEE_ROUNDTRIP_PERCENT` covers AMM pool fee + a slippage allowance as a flat % of position; 1.0 is a conservative starting point — raise if your routes show higher realized slippage. `MIN_NET_EXIT_PROFIT_PERCENT` 3→5 gives margin above the now-more-complete drag estimate.

- [ ] **Step 3: Build + dry-run check** — confirm the `Trailing HOLD by health/flow` logs now show a higher `netEst` gap (the guard holds more sub-break-even exits).

Run: `npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/price-monitor/price-monitor.service.ts config.json
git commit -m "fix(guard): include DEX fee + slippage in fee-drag, raise net-exit floor"
```

**Risk:** A higher/more-complete floor holds more positions through small bounces; over-tightening could delay legitimate exits. Tune `MIN_NET_EXIT_PROFIT_PERCENT` / `DEX_FEE_ROUNDTRIP_PERCENT` down if it never sells. Low-medium risk, config-reversible.
**Rollback:** restore the three config values; revert the one-line code add.

---

## Task 6 (P2): Tune trailing thresholds above break-even (config-only)

**Why:** Worst-case trailing lock-ins are below break-even (global ~1.5%, WHALE ~4.2%, MICIN ~5.3%). With Tasks 3+5 the guard/floor catch most of this, but tightening the config removes the reliance on the guard for the common path. This is config-only and fully reversible.

**Files:** Modify: `config.json`.

- [ ] **Step 1: Raise distances/activations** — edit `config.json` so each route's worst-case lock-in `(activation − distance)` clears its break-even. Starting point (tune to taste during review):

```json
  "TRAILING_DISTANCE_PERCENT": 1.25,
  "MICIN_TRAILING_ACTIVATION_PERCENT": 18,
  "WHALE_TRAILING_ACTIVATION_PERCENT": 14,
  "MICIN_TRAILING_DISTANCE_PERCENT": 5,
  "WHALE_TRAILING_DISTANCE_PERCENT": 3
```

> Rationale: WHALE lock-in 14−3 = 11% ≈ break-even; MICIN 18−5 = 13% (with Jito off, MICIN break-even drops to ~6–9%, so this is conservative). Adjust against live data.

- [ ] **Step 2: Sanity-check + commit**

```bash
git add config.json
git commit -m "chore(config): raise trailing activation/distance above break-even"
```

**Risk:** Wider trailing = give back more of a peak before exiting; intended trade-off. Low risk, instantly reversible.
**Rollback:** restore prior `config.json` values.

---

## Task 7 (P2): Remove the dead "Patience Protocol" block

**Why:** The 5-minute SL-hold / 10-minute-cap block (`price-monitor.service.ts:969-1027`) is unreachable — the hard-floor SL at line 821 always returns first for the identical `profitPercent <= -effectiveStopLossPercent` condition. Dead code is a maintenance trap and hides that the only hold gate before SL is the 90s window.

**Files:** Modify: `src/price-monitor/price-monitor.service.ts:968-1027`.

- [ ] **Step 1: Confirm unreachability** — verify nothing between line 821 and 969 reassigns `profitPercent` or `effectiveStopLossPercent` (it does not), so the line-969 condition can never be true after the line-821 block returns.

- [ ] **Step 2: Delete the block** — remove the `// 5. EXIT CONDITION: Patience Protocol ...` block (line 968 comment through the end of its `if` at ~1027). Do not touch the hard-floor SL block above it.

- [ ] **Step 3: Build + commit**

Run: `npm run build`
Expected: green (no references break).

```bash
git add src/price-monitor/price-monitor.service.ts
git commit -m "chore(exit): remove unreachable Patience Protocol dead code"
```

**Risk:** Pure cleanup if it is truly dead (confirmed). Low risk.
**Rollback:** revert the deletion.

---

## Suggested execution order & batching

1. **Batch A — stop the bleed (P0):** Task 1 → Task 2 → Task 3. Ship together, validate on dry-run + a few on-chain trades.
2. **Batch B — honest numbers (P1):** Task 4 → Task 5. Now the dashboard/breakers reflect reality; watch a day of live data.
3. **Batch C — tuning/cleanup (P2):** Task 6 → Task 7, guided by the now-trustworthy Batch B data.

## Self-Review (done)

- **Coverage:** all 6 verified root causes from the diagnosis map to a task (phantom→1, fixed-fee burden→2, gross accounting→4, runner floor→3, under-scoped/under-estimating guard→5, sub-break-even thresholds→3/6, dead code→7). The user's "no Jito under $3" directive = Task 2.
- **No placeholders:** every code step shows before/after; tests include real assertions.
- **Type consistency:** `computeNetProfitUsd` shape (`{profitUsd,totalFeesSol,solPriceAtEntry}`) is identical across risk metrics, win calc, and reporting. `calculateCleanSwapSolAmount` signature unchanged.
- **Safety:** no min-profit gate added to any safety exit; `profitUsd` column stays gross; all behavioral changes config-reversible.
- **Open decision for review:** exact value of `RUNNER_BREAKEVEN_FLOOR_PERCENT` (8 vs ~13) depends on whether you keep Jito on for ≥$3 trades — flagged in Task 3.
