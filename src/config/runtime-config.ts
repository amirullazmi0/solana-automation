import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

type RuntimeConfig = Record<string, unknown>;

type ConfigReader = {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
};

let cachedConfig: RuntimeConfig | null = null;

export function parseRuntimeConfigText(raw: string): RuntimeConfig {
    const normalized = raw.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(normalized) as RuntimeConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
}

function parseRuntimeConfig(): RuntimeConfig {
    if (cachedConfig) {
        return cachedConfig;
    }

    const configPath = resolve(process.cwd(), 'config.json');
    if (!existsSync(configPath)) {
        cachedConfig = {};
        return cachedConfig;
    }

    try {
        const raw = readFileSync(configPath, 'utf8');
        cachedConfig = parseRuntimeConfigText(raw);
    } catch {
        cachedConfig = {};
    }

    return cachedConfig;
}

export function loadRuntimeConfig(): RuntimeConfig {
    return parseRuntimeConfig();
}

export function getRuntimeNumber(key: string, fallback: number): number {
    const value = parseRuntimeConfig()[key];
    const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value));
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function getRuntimeString(key: string, fallback: string): string {
    const value = parseRuntimeConfig()[key];
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return fallback;
}

export function getRuntimeBoolean(key: string, fallback: boolean): boolean {
    const value = parseRuntimeConfig()[key];
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return fallback;
}

export function getRuntimePort(fallback = 3000): number {
    const port = getRuntimeNumber('PORT', fallback);
    return port > 0 ? port : fallback;
}

function readString(config: ConfigReader | RuntimeConfig, key: string, fallback: string): string {
    const isConfigReader = typeof (config as ConfigReader).get === 'function';
    const value = isConfigReader
        ? (config as ConfigReader).get<string>(key, fallback)
        : (config[key] as string | undefined);
    const text = String(value ?? fallback).trim();
    return text.length > 0 ? text : fallback;
}

function readNumber(config: ConfigReader | RuntimeConfig, key: string, fallback: number): number {
    const isConfigReader = typeof (config as ConfigReader).get === 'function';
    const value = isConfigReader
        ? (config as ConfigReader).get<string | number>(key, fallback)
        : (config[key] as string | number | undefined);
    const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value));
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function validateConfig(config: ConfigReader | RuntimeConfig): string[] {
    const errors: string[] = [];
    const totalCapital = readNumber(config, 'TOTAL_CAPITAL', 0);
    const reserveAmount = readNumber(config, 'RESERVE_AMOUNT', 0);
    const positionSizeUsd = readNumber(config, 'POSITION_SIZE_USD', 0);
    const totalSlots = readNumber(config, 'TOTAL_SLOTS', 0);
    const stopLossPercent = readNumber(config, 'STOP_LOSS_PERCENT', 0);
    const trailingDistancePercent = readNumber(config, 'TRAILING_DISTANCE_PERCENT', 0);
    const minMcap = readNumber(config, 'MIN_MCAP', 0);
    const maxMcap = readNumber(config, 'MAX_MCAP', 0);
    const maxSingleHolderPct = readNumber(config, 'MAX_SINGLE_HOLDER_PCT', 8);
    const maxTop5HolderPct = readNumber(config, 'MAX_TOP5_HOLDER_PCT', 15);
    const maxTop10HolderPct = readNumber(config, 'MAX_TOP10_HOLDER_PCT', 20);
    const maxTokenTransferFeeBps = readNumber(config, 'MAX_TOKEN_TRANSFER_FEE_BPS', 300);
    const roundtripThresholds = [
        readNumber(config, 'MAX_PREBUY_ROUNDTRIP_LOSS_PCT', 12),
        readNumber(config, 'MICIN_MAX_PREBUY_ROUNDTRIP_LOSS_PCT', 15),
        readNumber(config, 'WHALE_MAX_PREBUY_ROUNDTRIP_LOSS_PCT', 10),
    ];
    const liquidityWarnPct = readNumber(config, 'LIQUIDITY_DROP_WARN_PERCENT', 25);
    const liquidityExitPct = readNumber(config, 'LIQUIDITY_DROP_EXIT_PERCENT', 35);
    const liquidityPanicPct = readNumber(config, 'LIQUIDITY_DROP_PANIC_PERCENT', 60);
    const liquidityConfirmTicks = readNumber(config, 'LIQUIDITY_DROP_CONFIRM_TICKS', 2);
    const whaleDumpPct = readNumber(config, 'WHALE_DUMP_THRESHOLD_PERCENT', 20);
    const whalePanicPct = readNumber(config, 'WHALE_DUMP_PANIC_PERCENT', 50);
    const whaleConfirmTicks = readNumber(config, 'WHALE_DUMP_CONFIRM_TICKS', 2);
    const whaleSellBuyRatio = readNumber(config, 'WHALE_DUMP_SELL_BUY_RATIO', 1.2);
    const whaleMinSellCount = readNumber(config, 'WHALE_DUMP_MIN_SELL_COUNT', 5);
    const probeMinPositionUsd = readNumber(config, 'HONEYPOT_PROBE_MIN_POSITION_USD', 20);
    const probeUsd = readNumber(config, 'HONEYPOT_PROBE_USD', 0.5);
    const minPriceChange5mPct = readNumber(config, 'MIN_PRICE_CHANGE_5M_PCT', 0);
    const bearishReboundFloorPct = readNumber(config, 'BEARISH_REBOUND_1H_FLOOR_PCT', -60);
    const minH1BuyShare = readNumber(config, 'MIN_H1_BUY_SHARE', 0);
    const minH1BuyVolumeShare = readNumber(config, 'MIN_H1_BUY_VOLUME_SHARE', 0);
    const heliusFlowMaxPages = readNumber(config, 'HELIUS_FLOW_MAX_PAGES', 3);
    const drawdownLookbackHours = readNumber(config, 'RISK_DRAWDOWN_LOOKBACK_HOURS', 0);
    const narrativeCacheTtlMs = readNumber(config, 'NARRATIVE_CACHE_TTL_MS', 86400000);
    const narrativeTimeoutMs = readNumber(config, 'AI_NARRATIVE_TIMEOUT_MS', 8000);
    const narrativeMinConfidence = readString(config, 'NARRATIVE_MIN_CONFIDENCE', 'high').toLowerCase();
    const metaPnlWeight = readNumber(config, 'META_PNL_WEIGHT', 0.6);
    const metaMinTradeSample = readNumber(config, 'META_MIN_TRADE_SAMPLE', 8);
    const metaHotPercentile = readNumber(config, 'META_HOT_PERCENTILE', 70);
    const metaColdPercentile = readNumber(config, 'META_COLD_PERCENTILE', 30);
    const metaLabelBatchSize = readNumber(config, 'META_LABEL_BATCH_SIZE', 40);
    const metaLabelMaxPerHour = readNumber(config, 'META_LABEL_MAX_PER_HOUR', 120);
    const metaWindowHours = readNumber(config, 'META_WINDOW_HOURS', 12);
    const metaAccelWindowMin = readNumber(config, 'META_ACCEL_WINDOW_MIN', 60);
    const bearishReboundMin5mPct = readNumber(config, 'BEARISH_REBOUND_MIN_5M_PCT', 3);
    const aggressiveHolderLiquidityUsd = readNumber(
        config,
        'AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD',
        10000,
    );
    const aggressiveHolderLimits = [
        readNumber(config, 'AGGRESSIVE_MAX_SINGLE_HOLDER_PCT', 12),
        readNumber(config, 'AGGRESSIVE_MAX_TOP5_HOLDER_PCT', 28),
        readNumber(config, 'AGGRESSIVE_MAX_TOP10_HOLDER_PCT', 35),
    ];
    const aggressiveSafetyIndex = readNumber(config, 'AGGRESSIVE_RUGCHECK_MIN_SAFETY_INDEX', 0.65);
    const zeroLiquidityMaxRechecks = readNumber(config, 'ZERO_LIQUIDITY_MAX_RECHECKS', 15);
    const noDexPairMaxRetries = readNumber(config, 'NO_DEX_PAIR_MAX_RETRIES', 3);
    const noDexPairRetryBaseMs = readNumber(config, 'NO_DEX_PAIR_RETRY_BASE_MS', 250);
    const zeroLiquidityMaxRetries = readNumber(config, 'ZERO_LIQUIDITY_MAX_RETRIES', 8);
    const zeroLiquidityRetryBaseMs = readNumber(config, 'ZERO_LIQUIDITY_RETRY_BASE_MS', 2000);
    const zeroLiquidityActiveRetryMaxAgeMin = readNumber(
        config,
        'ZERO_LIQUIDITY_ACTIVE_RETRY_MAX_AGE_MIN',
        15,
    );

    if (stopLossPercent <= 0) {
        errors.push('STOP_LOSS_PERCENT must be greater than 0.');
    }
    if (trailingDistancePercent <= 0) {
        errors.push('TRAILING_DISTANCE_PERCENT must be greater than 0.');
    }
    if (minMcap >= maxMcap) {
        errors.push('MIN_MCAP must be lower than MAX_MCAP.');
    }
    if (
        maxSingleHolderPct <= 0 ||
        maxSingleHolderPct > maxTop5HolderPct ||
        maxTop5HolderPct > maxTop10HolderPct ||
        maxTop10HolderPct > 100
    ) {
        errors.push(
            'Holder limits must satisfy 0 < MAX_SINGLE_HOLDER_PCT <= MAX_TOP5_HOLDER_PCT <= MAX_TOP10_HOLDER_PCT <= 100.',
        );
    }
    if (maxTokenTransferFeeBps < 0 || maxTokenTransferFeeBps > 10000) {
        errors.push('MAX_TOKEN_TRANSFER_FEE_BPS must be between 0 and 10000.');
    }
    if (roundtripThresholds.some((value) => value < 0 || value > 100)) {
        errors.push('Pre-buy roundtrip loss thresholds must be between 0 and 100.');
    }
    if (
        liquidityWarnPct < 0 ||
        liquidityWarnPct > liquidityExitPct ||
        liquidityExitPct > liquidityPanicPct ||
        liquidityPanicPct > 100
    ) {
        errors.push('Liquidity thresholds must satisfy 0 <= WARN <= EXIT <= PANIC <= 100.');
    }
    if (!Number.isInteger(liquidityConfirmTicks) || liquidityConfirmTicks < 1) {
        errors.push('LIQUIDITY_DROP_CONFIRM_TICKS must be an integer >= 1.');
    }
    if (whaleDumpPct < 0 || whaleDumpPct > whalePanicPct || whalePanicPct > 100) {
        errors.push('Whale thresholds must satisfy 0 <= DUMP <= PANIC <= 100.');
    }
    if (!Number.isInteger(whaleConfirmTicks) || whaleConfirmTicks < 1) {
        errors.push('WHALE_DUMP_CONFIRM_TICKS must be an integer >= 1.');
    }
    if (whaleSellBuyRatio < 1 || whaleMinSellCount < 1) {
        errors.push('Whale seller pressure ratio and minimum sell count must be >= 1.');
    }
    if (probeUsd <= 0 || probeMinPositionUsd < probeUsd) {
        errors.push('HONEYPOT_PROBE_USD must be > 0 and <= HONEYPOT_PROBE_MIN_POSITION_USD.');
    }
    if (minPriceChange5mPct < -5 || minPriceChange5mPct > 100) {
        errors.push('MIN_PRICE_CHANGE_5M_PCT must be between -5 and 100.');
    }
    if (bearishReboundFloorPct < -100 || bearishReboundFloorPct >= -15) {
        errors.push('BEARISH_REBOUND_1H_FLOOR_PCT must be between -100 and below -15.');
    }
    if (bearishReboundMin5mPct < 0 || bearishReboundMin5mPct > 100) {
        errors.push('BEARISH_REBOUND_MIN_5M_PCT must be between 0 and 100.');
    }
    // Shares, not percentages: 0.6 means 60% of flow. A value above 1 is always a unit mix-up
    // (someone typing 60), and it would silently reject every token.
    if (minH1BuyShare < 0 || minH1BuyShare > 1) {
        errors.push('MIN_H1_BUY_SHARE must be a share between 0 and 1 (0 disables the gate).');
    }
    if (minH1BuyVolumeShare < 0 || minH1BuyVolumeShare > 1) {
        errors.push('MIN_H1_BUY_VOLUME_SHARE must be a share between 0 and 1 (0 disables the gate).');
    }
    if (!Number.isInteger(heliusFlowMaxPages) || heliusFlowMaxPages < 1) {
        errors.push('HELIUS_FLOW_MAX_PAGES must be an integer >= 1.');
    }
    // 0 disables the rolling window and falls back to RISK_PNL_START_AT alone, which is the
    // configuration that produced a permanently latched drawdown breaker.
    if (drawdownLookbackHours < 0) {
        errors.push('RISK_DRAWDOWN_LOOKBACK_HOURS must be >= 0 (0 disables the rolling window).');
    }
    if (narrativeCacheTtlMs < 60000) {
        errors.push('NARRATIVE_CACHE_TTL_MS must be >= 60000; narrative verdicts are static per token.');
    }
    // Must stay inside the RugCheck window it rides on, or the answer arrives after the decision.
    if (narrativeTimeoutMs < 500 || narrativeTimeoutMs > 30000) {
        errors.push('AI_NARRATIVE_TIMEOUT_MS must be between 500 and 30000.');
    }
    if (!['high', 'medium', 'low'].includes(narrativeMinConfidence)) {
        errors.push('NARRATIVE_MIN_CONFIDENCE must be one of high, medium, low.');
    }
    // META_PNL_WEIGHT is a share, not a multiplier: above 1 the activity term goes negative and
    // ranks the quietest metas highest, which is the exact inverse of the intent.
    if (metaPnlWeight < 0 || metaPnlWeight > 1) {
        errors.push('META_PNL_WEIGHT must be between 0 and 1; it is the P&L share of the blend.');
    }
    // A sample of one makes every single-trade label either the best or the worst meta on the
    // board, and TOXIC can reject candidates, so the floor is deliberately above 1.
    if (metaMinTradeSample < 2) {
        errors.push('META_MIN_TRADE_SAMPLE must be >= 2; one trade cannot characterise a meta.');
    }
    if (metaColdPercentile < 0 || metaHotPercentile > 100 || metaColdPercentile >= metaHotPercentile) {
        errors.push(
            'META_COLD_PERCENTILE must be >= 0 and strictly below META_HOT_PERCENTILE, which must be <= 100.',
        );
    }
    if (metaLabelBatchSize < 1 || metaLabelBatchSize > 200) {
        errors.push('META_LABEL_BATCH_SIZE must be between 1 and 200.');
    }
    if (metaLabelMaxPerHour < 0) {
        errors.push('META_LABEL_MAX_PER_HOUR must be >= 0 (0 disables labelling entirely).');
    }
    if (metaWindowHours < 1) {
        errors.push('META_WINDOW_HOURS must be >= 1.');
    }
    // A recent slice as long as the window leaves no baseline to compare against, which collapses
    // every label to the same flat ratio -- the exact failure volumeSurge had before it was fixed.
    if (metaAccelWindowMin < 5 || metaAccelWindowMin >= metaWindowHours * 60) {
        errors.push(
            'META_ACCEL_WINDOW_MIN must be >= 5 and strictly less than META_WINDOW_HOURS in minutes.',
        );
    }
    if (aggressiveHolderLiquidityUsd < 0) {
        errors.push('AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD must be >= 0.');
    }
    if (
        aggressiveHolderLimits[0] <= 0 ||
        aggressiveHolderLimits[0] > aggressiveHolderLimits[1] ||
        aggressiveHolderLimits[1] > aggressiveHolderLimits[2] ||
        aggressiveHolderLimits[2] > 100
    ) {
        errors.push(
            'Aggressive holder limits must satisfy 0 < SINGLE <= TOP5 <= TOP10 <= 100.',
        );
    }
    if (aggressiveSafetyIndex <= 0 || aggressiveSafetyIndex > 1) {
        errors.push('AGGRESSIVE_RUGCHECK_MIN_SAFETY_INDEX must be between 0 and 1.');
    }
    if (!Number.isInteger(zeroLiquidityMaxRechecks) || zeroLiquidityMaxRechecks < 1) {
        errors.push('ZERO_LIQUIDITY_MAX_RECHECKS must be an integer >= 1.');
    }
    if (!Number.isInteger(noDexPairMaxRetries) || noDexPairMaxRetries < 1) {
        errors.push('NO_DEX_PAIR_MAX_RETRIES must be an integer >= 1.');
    }
    if (!Number.isInteger(noDexPairRetryBaseMs) || noDexPairRetryBaseMs < 100) {
        errors.push('NO_DEX_PAIR_RETRY_BASE_MS must be an integer >= 100.');
    }
    if (!Number.isInteger(zeroLiquidityMaxRetries) || zeroLiquidityMaxRetries < 1) {
        errors.push('ZERO_LIQUIDITY_MAX_RETRIES must be an integer >= 1.');
    }
    if (!Number.isInteger(zeroLiquidityRetryBaseMs) || zeroLiquidityRetryBaseMs < 500) {
        errors.push('ZERO_LIQUIDITY_RETRY_BASE_MS must be an integer >= 500.');
    }
    if (zeroLiquidityActiveRetryMaxAgeMin < 0) {
        errors.push('ZERO_LIQUIDITY_ACTIVE_RETRY_MAX_AGE_MIN must be >= 0.');
    }

    const spendableCapital = totalCapital - reserveAmount;
    const requiredCapital = positionSizeUsd * totalSlots;
    if (spendableCapital < requiredCapital) {
        errors.push(
            `Capital coverage invalid: TOTAL_CAPITAL - RESERVE_AMOUNT (${spendableCapital}) must be >= POSITION_SIZE_USD * TOTAL_SLOTS (${requiredCapital}).`,
        );
    }

    return errors;
}
