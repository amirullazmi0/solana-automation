import { Controller, Get, Param, Query, Res, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';
import { TradeService } from './trade/trade.service';
import { AnalyzerService } from './analyzer/analyzer.service';
import { Response } from 'express';

@Controller()
export class AppController {
    private readonly logger = new Logger(AppController.name);

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
    async manualBuy(
        @Param('mint') tokenMint: string,
        @Query('force') force: string,
        @Res() res: Response,
    ) {
        try {
            const isForced = force === 'true';

            if (!isForced) {
                const isSafe = await this.analyzerService.isTokenSafeToBuy(tokenMint);
                if (!isSafe) {
                    return res.status(HttpStatus.BAD_REQUEST).json({
                        message: `Token ${tokenMint} failed safety checks (RugCheck or Authority checks). Buy aborted. Use ?force=true to bypass.`,
                    });
                }
            } else {
                this.logger.warn(`[FORCE BUY] Bypassing safety checks for ${tokenMint}`);
            }

            // Trigger buy asynchronously
            await this.tradeService.attemptBuy(tokenMint);

            return res.status(HttpStatus.OK).json({
                message: `Token ${tokenMint} passed safety checks! Buy order dispatched to Jupiter. Check your Telegram/Console for results.`,
            });
        } catch (error) {
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
        }
    }
}
