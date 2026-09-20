import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { EstablishedAnalyzerService } from './established-analyzer.service';
import { TradeModule } from '../trade/trade.module';
import { CreatorProfileService } from './creator-profile.service';
import { FlowVolumeService } from './flow-volume.service';
import { NarrativeService } from './narrative.service';
import { AIModule } from '../ai/ai.module';
import { MetaModule } from '../meta/meta.module';

@Module({
    imports: [TradeModule, AIModule, MetaModule],
    providers: [AnalyzerService, EstablishedAnalyzerService, CreatorProfileService, FlowVolumeService, NarrativeService],
    exports: [AnalyzerService, EstablishedAnalyzerService, CreatorProfileService, FlowVolumeService, NarrativeService],
})
export class AnalyzerModule {}
