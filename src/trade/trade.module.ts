import { Module } from '@nestjs/common';
import { TradeService } from './trade.service';
import { PaperTradeService } from './paper-trade.service';

@Module({
    providers: [TradeService, PaperTradeService],
    exports: [TradeService, PaperTradeService],
})
export class TradeModule {}
