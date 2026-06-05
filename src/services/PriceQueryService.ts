import type { HotelPriceProvider, HotelPriceResult, PriceQuery } from '../modules/base/types.js';
import { env } from '../config/env.js';

export class PriceQueryService {
  constructor(
    private readonly providers: HotelPriceProvider[],
    private readonly concurrency = env.PROVIDER_CONCURRENCY,
  ) {}
// 添加了并发控制，按照env.PROVIDER_CONCURRENCY中并发严格控制
  async queryAll(input: PriceQuery): Promise<HotelPriceResult[]> {
    const settled = await allSettledWithConcurrency(
      this.providers,
      this.concurrency,
      async (provider) => provider.query(input),
    );

    return settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      const provider = this.providers[index];
      return {
        provider: provider.name,
        hotelName: input.hotelName,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        available: false,
        status: 'error',
        errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason),
        queriedAt: new Date().toISOString(),
      };
    });
  }
}

async function allSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = {
          status: 'fulfilled',
          value: await operation(items[index], index),
        };
      } catch (reason) {
        results[index] = {
          status: 'rejected',
          reason,
        };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function normalizeConcurrency(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
