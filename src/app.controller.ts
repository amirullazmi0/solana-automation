import { Controller, Get, Param, Query, Res, HttpStatus, Logger } from '@nestjs/common';
import { AppService } from './app.service';
import { TradeService } from './trade/trade.service';
import { AnalyzerService } from './analyzer/analyzer.service';
import { ScannerService } from './scanner/scanner.service';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';

@Controller()
export class AppController {
    private readonly logger = new Logger(AppController.name);
    private readonly apiSecretKey: string;

    constructor(
        private readonly appService: AppService,
        private readonly tradeService: TradeService,
        private readonly analyzerService: AnalyzerService,
        private readonly scannerService: ScannerService,
        private readonly configService: ConfigService,
    ) {
        this.apiSecretKey = this.configService.get<string>('API_SECRET_KEY', '');
    }

    @Get()
    getHello(): string {
        return this.appService.getHello();
    }

    @Get('buy/:mint')
    async manualBuy(
        @Param('mint') tokenMint: string,
        @Query('force') force: string,
        @Query('key') apiKey: string,
        @Res() res: Response,
    ) {
        try {
            // 🛡️ API KEY GUARD: Prevent unauthorized access
            if (!this.apiSecretKey || apiKey !== this.apiSecretKey) {
                return res.status(HttpStatus.UNAUTHORIZED).json({
                    message: 'Unauthorized. Provide valid API key via ?key=YOUR_KEY',
                });
            }

            const isForced = force === 'true';

            if (!isForced) {
                const result = await this.analyzerService.isTokenSafeToBuy(tokenMint);
                if (!result.safe) {
                    return res.status(HttpStatus.BAD_REQUEST).json({
                        message: `Token ${tokenMint} failed safety checks: ${result.reason || 'unknown'}. Use ?force=true to bypass.`,
                    });
                }
            } else {
                this.logger.warn(`[FORCE BUY] Bypassing safety checks for ${tokenMint}`);
            }

            const result = await this.tradeService.attemptBuy(tokenMint);

            return res.status(HttpStatus.OK).json({
                message: `Token ${tokenMint} processed!`,
                result,
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: msg });
        }
    }

    @Get('health')
    async healthCheck(@Res() res: Response) {
        try {
            const scannerStatus = this.scannerService.getScannerStatus();

            return res.status(HttpStatus.OK).json({
                status: 'ok',
                uptime: process.uptime(),
                scanner: scannerStatus,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ status: 'error', error: msg });
        }
    }
}
