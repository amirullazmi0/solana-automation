import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramWorkspaceService } from './telegram-workspace.service';

@Global()
@Module({
    imports: [PrismaModule],
    providers: [TelegramWorkspaceService],
    exports: [TelegramWorkspaceService],
})
export class TelegramModule {}
