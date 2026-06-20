import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { PriceMonitorService } from './price-monitor.service';
import { TradeModule } from '../trade/trade.module';

@Module({
    imports: [TradeModule, AIModule],
    providers: [PriceMonitorService],
})
export class PriceMonitorModule {}
