import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';
import { TradeService } from './trade/trade.service';
import { AnalyzerService } from './analyzer/analyzer.service';
import { Response } from 'express';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly tradeService: TradeService,
    private readonly analyzerService: AnalyzerService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('buy/:mint')
  async manualBuy(@Param('mint') tokenMint: string, @Res() res: Response) {
    try {
      const isSafe = await this.analyzerService.isTokenSafeToBuy(tokenMint);
      if (!isSafe) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          message: `Token ${tokenMint} failed safety checks (RugCheck or Authority checks). Buy aborted.`
        });
      }

      // Trigger buy asynchronously so we don't block the HTTP response too long
      await this.tradeService.attemptBuy(tokenMint);
      
      return res.status(HttpStatus.OK).json({
        message: `Token ${tokenMint} passed safety checks! Buy order dispatched to Jupiter. Check your Telegram/Console for results.`
      });
    } catch (error) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
    }
  }
}
