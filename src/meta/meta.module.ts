import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIModule } from '../ai/ai.module';
import { MetaLabelService } from './meta-label.service';
import { MetaSocialSource, NullMetaSocialSource, XMetaSocialSource } from './meta-social';
import { MetaTrendService } from './meta-trend.service';

/**
 * Global because four unrelated places need the same heat numbers: the analyzer scores with them,
 * the scanner orders its radar by them, the trade path stamps the label onto a row, and reporting
 * publishes the leaderboard. Threading the module through each of those import lists would create
 * a cycle -- AnalyzerModule already imports TradeModule, which reporting depends on in turn.
 *
 * The social source is bound by a factory rather than by two conditional providers so the choice
 * is made once, at boot, from config. Everything downstream depends on the abstract class and is
 * identical whether or not the paid integration is switched on.
 */
@Global()
@Module({
    imports: [AIModule],
    providers: [
        MetaLabelService,
        MetaTrendService,
        {
            provide: MetaSocialSource,
            inject: [ConfigService],
            useFactory: (configService: ConfigService): MetaSocialSource => {
                const enabled =
                    String(
                        configService.get('ENABLE_META_SOCIAL_SOURCE', 'false'),
                    ).toLowerCase() === 'true';
                return enabled
                    ? new XMetaSocialSource(configService)
                    : new NullMetaSocialSource();
            },
        },
    ],
    exports: [MetaLabelService, MetaTrendService, MetaSocialSource],
})
export class MetaModule {}
