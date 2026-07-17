import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export class AsyncSemaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        this.active++;
        try {
            return await operation();
        } finally {
            this.active--;
            this.waiters.shift()?.();
        }
    }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
    private readonly querySemaphore: AsyncSemaphore;

    constructor() {
        super();
        const configured = Number.parseInt(
            process.env.PRISMA_APP_MAX_CONCURRENT || '4',
            10,
        );
        this.querySemaphore = new AsyncSemaphore(
            Number.isFinite(configured) && configured > 0 ? configured : 4,
        );
        this.$use((params, next) => this.querySemaphore.run(() => next(params)));
    }

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
