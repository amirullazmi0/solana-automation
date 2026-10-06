import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { AppModule } from './app.module';
import { validateConfig } from './config/runtime-config';
import * as dns from 'dns';

// FORCE Google & Cloudflare DNS to bypass ISP blocks and Windows ENOTFOUND issues
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

async function bootstrap() {
    console.log('[DEBUG] Starting NestJS Bootstrap...');
    // Typed as an Express app so `useStaticAssets` is available. The plain `NestFactory.create`
    // returns an `INestApplication`, which has no notion of static files.
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    const configService = app.get(ConfigService);
    const configErrors = validateConfig(configService);
    if (configErrors.length > 0) {
        console.error('[CONFIG] Invalid runtime configuration:');
        for (const error of configErrors) {
            console.error(`[CONFIG] - ${error}`);
        }
        await app.close();
        process.exit(1);
    }

    // Serves the zone dashboard. The directory sits at the repo root rather than under `src/`
    // because `nest-cli.json` sets `deleteOutDir: true` with no `assets` entry, so anything
    // non-.ts inside `src/` is wiped from `dist/` on every build.
    const dashboardEnabled =
        String(configService.get('ENABLE_DASHBOARD', 'true')).toLowerCase() !== 'false';
    if (dashboardEnabled) {
        app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/dashboard' });
        console.log('[DEBUG] Dashboard served at /dashboard');
    }

    // 🛡️ GRACEFUL SHUTDOWN: Biar in-progress sell bisa selesai sebelum restart
    app.enableShutdownHooks();

    const port = Number.parseInt(configService.get<string>('PORT', '3000'), 10) || 3000;
    console.log(`[DEBUG] Attempting to listen on port ${port}...`);

    await app.listen(port);
    console.log(`[DEBUG] Application is successfully listening on port ${port}`);
}
bootstrap();
