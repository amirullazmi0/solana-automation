import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { validateConfig } from './config/runtime-config';
import * as dns from 'dns';

// FORCE Google & Cloudflare DNS to bypass ISP blocks and Windows ENOTFOUND issues
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

async function bootstrap() {
    console.log('[DEBUG] Starting NestJS Bootstrap...');
    const app = await NestFactory.create(AppModule);
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

    // 🛡️ GRACEFUL SHUTDOWN: Biar in-progress sell bisa selesai sebelum restart
    app.enableShutdownHooks();

    const port = Number.parseInt(configService.get<string>('PORT', '3000'), 10) || 3000;
    console.log(`[DEBUG] Attempting to listen on port ${port}...`);

    await app.listen(port);
    console.log(`[DEBUG] Application is successfully listening on port ${port}`);
}
bootstrap();
