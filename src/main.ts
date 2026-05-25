import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dns from 'dns';

// FORCE Google & Cloudflare DNS to bypass ISP blocks and Windows ENOTFOUND issues
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

async function bootstrap() {
    console.log('[DEBUG] Starting NestJS Bootstrap...');
    const app = await NestFactory.create(AppModule);

    // 🛡️ GRACEFUL SHUTDOWN: Biar in-progress sell bisa selesai sebelum restart
    app.enableShutdownHooks();

    const port = 3000;
    console.log(`[DEBUG] Attempting to listen on port ${port}...`);

    await app.listen(port);
    console.log(`[DEBUG] Application is successfully listening on port ${port}`);
}
bootstrap();
