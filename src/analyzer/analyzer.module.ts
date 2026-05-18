import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { EstablishedAnalyzerService } from './established-analyzer.service';
import { TradeModule } from '../trade/trade.module';

@Module({
    imports: [TradeModule],
    providers: [AnalyzerService, EstablishedAnalyzerService],
    exports: [AnalyzerService, EstablishedAnalyzerService],
})
export class AnalyzerModule {}
