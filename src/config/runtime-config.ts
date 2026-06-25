import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

type RuntimeConfig = Record<string, unknown>;

type ConfigReader = {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
};

let cachedConfig: RuntimeConfig | null = null;

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
        const parsed = JSON.parse(raw) as RuntimeConfig;
        cachedConfig = parsed && typeof parsed === 'object' ? parsed : {};
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
    const isConfigReader =
        typeof (config as ConfigReader).get === 'function';
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

    if (stopLossPercent <= 0) {
        errors.push('STOP_LOSS_PERCENT must be greater than 0.');
    }
    if (trailingDistancePercent <= 0) {
        errors.push('TRAILING_DISTANCE_PERCENT must be greater than 0.');
    }
    if (minMcap >= maxMcap) {
        errors.push('MIN_MCAP must be lower than MAX_MCAP.');
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
