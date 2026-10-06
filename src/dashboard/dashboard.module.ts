import { Module } from '@nestjs/common';
import { CandleService } from './candle.service';
import { DashboardController } from './dashboard.controller';
import { RiskService } from './risk.service';
import { ZoneDigestService } from './zone-digest.service';

/**
 * Read-only zone dashboard.
 *
 * Needs no imports: `PrismaModule` and `MetaModule` are both global, and nothing here touches the
 * trade path. Keeping it dependency-free is deliberate — a viewing surface should never be able to
 * reach anything that spends money.
 */
@Module({
    controllers: [DashboardController],
    providers: [CandleService, RiskService, ZoneDigestService],
    exports: [CandleService, RiskService, ZoneDigestService],
})
export class DashboardModule {}
