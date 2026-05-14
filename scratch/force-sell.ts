import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TradeService } from '../src/trade/trade.service';

async function forceSell() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const tradeService = app.get(TradeService);

    // ID slot yang mau dijual (Amankan profit!)
    const idsToSell = [3, 4, 6]; 
    
    console.log('🚀 Memulai Force Sell untuk amankan profit...');

    for (const id of idsToSell) {
        try {
            // Kita pakai harga estimasi tertinggi sekarang $0.1283
            await tradeService.executeSell(id, 0.1283, 'FORCE_SELL');
            console.log(`✅ Slot ID ${id} berhasil dijual! Profit diamankan.`);
        } catch (e) {
            console.error(`❌ Gagal jual Slot ID ${id}:`, e.message);
        }
    }

    await app.close();
}

forceSell();
