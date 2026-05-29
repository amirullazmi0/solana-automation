import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
    async onModuleInit() {
        try {
            console.log('[DEBUG] Connecting to Database...');
            await this.$connect();
            console.log('[DEBUG] Database connection successful.');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ERROR] Database connection failed:', msg);
            const failFast = (process.env.DB_FAIL_FAST || 'true') === 'true';
            if (failFast) throw error;
        }
    }
}
