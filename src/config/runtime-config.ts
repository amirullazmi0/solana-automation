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

    const spendableCapital = totalCapital - reserveAmount;
    const requiredCapital = positionSizeUsd * totalSlots;
    if (spendableCapital < requiredCapital) {
        errors.push(
            `Capital coverage invalid: TOTAL_CAPITAL - RESERVE_AMOUNT (${spendableCapital}) must be >= POSITION_SIZE_USD * TOTAL_SLOTS (${requiredCapital}).`,
        );
    }

    return errors;
}
