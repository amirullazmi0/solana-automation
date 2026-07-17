import { AsyncSemaphore } from './prisma.service';

describe('AsyncSemaphore', () => {
    it('limits concurrent database operations', async () => {
        const semaphore = new AsyncSemaphore(2);
        let active = 0;
        let maxActive = 0;

        const operations = Array.from({ length: 6 }, () =>
            semaphore.run(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active--;
            }),
        );

        await Promise.all(operations);
        expect(maxActive).toBe(2);
    });

    it('releases a slot when an operation rejects', async () => {
        const semaphore = new AsyncSemaphore(1);
        await expect(
            semaphore.run(async () => {
                throw new Error('db failed');
            }),
        ).rejects.toThrow('db failed');
        await expect(semaphore.run(async () => 'recovered')).resolves.toBe('recovered');
    });
});
