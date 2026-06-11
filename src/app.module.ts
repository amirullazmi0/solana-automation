import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ReportingModule } from './reporting/reporting.module';
import { AnalyzerModule } from './analyzer/analyzer.module';
import { ScannerModule } from './scanner/scanner.module';
import { TradeModule } from './trade/trade.module';
import { PriceMonitorModule } from './price-monitor/price-monitor.module';
import { AIModule } from './ai/ai.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),
        ScheduleModule.forRoot(),
        PrismaModule,
        TelegramModule,
        ReportingModule,
        AnalyzerModule,
        ScannerModule,
        TradeModule,
        PriceMonitorModule,
        AIModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
