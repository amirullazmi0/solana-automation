import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { EstablishedAnalyzerService } from './established-analyzer.service';
import { TradeModule } from '../trade/trade.module';
import { CreatorProfileService } from './creator-profile.service';
import { AIModule } from '../ai/ai.module';

@Module({
    imports: [TradeModule, AIModule],
    providers: [AnalyzerService, EstablishedAnalyzerService, CreatorProfileService],
    exports: [AnalyzerService, EstablishedAnalyzerService, CreatorProfileService],
})
export class AnalyzerModule {}
