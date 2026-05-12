import { Global, Module } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
    imports: [PrismaModule],
    providers: [ReportingService],
    exports: [ReportingService],
})
export class ReportingModule {}
