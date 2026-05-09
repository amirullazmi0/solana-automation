import { Module } from '@nestjs/common';
import { PriceMonitorService } from './price-monitor.service';
import { TradeModule } from '../trade/trade.module';

@Module({
  imports: [TradeModule],
  providers: [PriceMonitorService],
})
export class PriceMonitorModule {}
