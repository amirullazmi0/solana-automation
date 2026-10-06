import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { MetaLabelService } from '../meta/meta-label.service';
import { MetaTrendService } from '../meta/meta-trend.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandleService } from './candle.service';
import { RiskService } from './risk.service';
import { DashboardController } from './dashboard.controller';

/**
 * The guard, tested without a network or a database.
 *
 * These routes expose the watchlist and the candidate list on an app that is publicly reachable, so
 * the guard is the only thing between them and the internet. It is also the piece most easily broken
 * by an unrelated edit, which is exactly what a test is for.
 */
describe('DashboardController guard', () => {
    function build(config: Record<string, unknown>) {
        const configService = {
            get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback),
        } as unknown as ConfigService;

        const controller = new DashboardController(
            configService,
            {} as CandleService,
            {} as RiskService,
            {} as PrismaService,
            {} as MetaTrendService,
            {} as MetaLabelService,
        );

        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const res = { status, json } as unknown as Response;

        return { controller, res, status, json };
    }

    it('rejects a missing key with 401 rather than serving the watchlist', async () => {
        const { controller, res, status, json } = build({ API_SECRET_KEY: 'secret' });

        await expect(controller.coins(undefined as unknown as string, '', res)).resolves.toBeUndefined();
        expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('Unauthorized') }),
        );
    });

    it('rejects a wrong key with 401', async () => {
        const { controller, res, status } = build({ API_SECRET_KEY: 'secret' });

        await controller.coins('wrong', '', res);
        expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    });

    // Fail closed, copied from `app.controller.ts`. An unset secret must lock the door rather than
    // remove it: the opposite default would open the watchlist on any deploy that forgot the env var.
    it('rejects everything when API_SECRET_KEY is unset', async () => {
        const { controller, res, status } = build({});

        await controller.coins('', '', res);
        expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    });

    // `ENABLE_DASHBOARD` names the whole feature, not just the static page. Before this the flag
    // only stopped `useStaticAssets` in `main.ts`, so a dashboard that was "off" still answered on
    // its API and still listed the watchlist -- the precise surprise a kill switch exists to prevent.
    it('answers 404 on every route when the dashboard is disabled, even with the right key', async () => {
        const { controller, res, status } = build({
            API_SECRET_KEY: 'secret',
            ENABLE_DASHBOARD: false,
        });

        await controller.coins('secret', '', res);
        expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);

        await controller.price('mint', 'secret', res);
        expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);

        await controller.zones('mint', 'secret', res);
        expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    });

    // The flag arrives as a real boolean from config.json and as a string from the environment, and
    // `'false'` is truthy, so a naive check would read the string form as enabled.
    it('reads the disable flag whether it arrives as a boolean or a string', async () => {
        for (const value of [false, 'false', 'FALSE']) {
            const { controller, res, status } = build({
                API_SECRET_KEY: 'secret',
                ENABLE_DASHBOARD: value,
            });
            await controller.coins('secret', '', res);
            expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
        }

        for (const value of [true, 'true', undefined]) {
            const config: Record<string, unknown> = { API_SECRET_KEY: 'secret' };
            if (value !== undefined) config.ENABLE_DASHBOARD = value;
            const { controller, res, status } = build(config);
            // Wrong key, so it stops at 401 -- which proves it got past the disabled check.
            await controller.coins('wrong', '', res);
            expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
        }
    });
});

/**
 * The dashboard is a viewing surface and must stay one. Buying and selling live in Telegram.
 *
 * Asserted against the source text rather than behaviour, because the thing worth preventing is not
 * a bug in today's code -- today's code has no trade path at all -- but a future edit that quietly
 * adds one. A reviewer can miss an added import; this cannot.
 */
describe('dashboard cannot trade', () => {
    const dir = resolve(__dirname);
    const sources = readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
        .map((f) => ({ file: f, text: readFileSync(resolve(dir, f), 'utf8') }));

    it('has source files to check', () => {
        expect(sources.length).toBeGreaterThan(3);
    });

    it('exposes only GET routes', () => {
        for (const { file, text } of sources) {
            const methods = text.match(/@(Get|Post|Put|Patch|Delete)\(/g) ?? [];
            const nonGet = methods.filter((m) => !m.startsWith('@Get'));
            expect({ file, nonGet }).toEqual({ file, nonGet: [] });
        }
    });

    it('never references the trade path, a wallet, or transaction signing', () => {
        const forbidden = [
            'TradeService',
            'TradeModule',
            'PriceMonitorService',
            'Keypair',
            'sendTransaction',
            'signTransaction',
            'sendAndConfirm',
            'JupiterLimiter',
        ];
        for (const { file, text } of sources) {
            const hits = forbidden.filter((name) => text.includes(name));
            expect({ file, hits }).toEqual({ file, hits: [] });
        }
    });

    it('never writes to the database', () => {
        // `prismaService.<model>.create|update|upsert|delete` in any form. The cache's own
        // `Map.delete` is not a database call, so the model prefix is what is matched.
        const write = /prisma\w*\.\w+\.(create|update|upsert|delete)\w*\(/;
        for (const { file, text } of sources) {
            expect({ file, writes: write.test(text) }).toEqual({ file, writes: false });
        }
    });
});
