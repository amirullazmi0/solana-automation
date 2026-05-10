import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dns from 'dns';

// FORCE Google & Cloudflare DNS to bypass ISP blocks and Windows ENOTFOUND issues
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    await app.listen(4000);
}
bootstrap();
