import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

type RuntimeConfig = Record<string, unknown>;

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
