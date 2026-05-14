import { Module } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { TradeModule } from '../trade/trade.module';
import { ReportingModule } from '../reporting/reporting.module';
import { AnalyzerModule } from 'src/analyzer/analyzer.module';

@Module({
    imports: [TradeModule, AnalyzerModule, ReportingModule],
    providers: [ScannerService],
    exports: [ScannerService],
})
export class ScannerModule {}
