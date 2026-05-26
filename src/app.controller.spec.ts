import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TradeService } from './trade/trade.service';
import { AnalyzerService } from './analyzer/analyzer.service';
import { ScannerService } from './scanner/scanner.service';
import { ConfigService } from '@nestjs/config';

describe('AppController', () => {
    let appController: AppController;

    beforeEach(async () => {
        const app: TestingModule = await Test.createTestingModule({
            controllers: [AppController],
            providers: [
                AppService,
                { provide: TradeService, useValue: {} },
                { provide: AnalyzerService, useValue: {} },
                { provide: ScannerService, useValue: {} },
                { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('') } },
            ],
        }).compile();

        appController = app.get<AppController>(AppController);
    });

    describe('root', () => {
        it('should return "Hello World!"', () => {
            expect(appController.getHello()).toBe('Hello World!');
        });
    });
});
