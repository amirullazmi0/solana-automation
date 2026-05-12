import { Module } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { TradeModule } from '../trade/trade.module';
import { AnalyzerModule } from '../analyzer/analyzer.module';

@Module({
    imports: [TradeModule, AnalyzerModule],
    providers: [ScannerService],
})
export class ScannerModule {}
