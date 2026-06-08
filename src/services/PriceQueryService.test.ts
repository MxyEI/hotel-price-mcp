import assert from 'node:assert/strict';
import test from 'node:test';
import type { HotelPriceProvider, HotelPriceResult, PriceQuery, ProviderName } from '../modules/base/types.js';

test('honors PROVIDER_CONCURRENCY=1 by running provider queries sequentially', async () => {
  process.env.PROVIDER_CONCURRENCY = '1';
  const { PriceQueryService } = await import('./PriceQueryService.js');
  const firstGate = deferred<void>();
  const events: string[] = [];
  const input: PriceQuery = {
    hotelName: '西安皇冠假日',
    checkIn: '2026-06-12',
    checkOut: '2026-06-13',
    rooms: 1,
    adults: 2,
    children: 0,
  };

  const providers: HotelPriceProvider[] = [
    // provider('ctrip', async () => {
    //   events.push('ctrip:start');
    //   await firstGate.promise;
    //   events.push('ctrip:end');
    // }),
    provider('ihg', async () => {
      events.push('ihg:start');
      events.push('ihg:end');
    }),
  ];

  const service = new PriceQueryService(providers);
  const resultsPromise = service.queryAll(input);

  await waitFor(() => events.includes('ctrip:start'));
  await settleMicrotasks();

  assert.deepEqual(events, ['ctrip:start']);

  firstGate.resolve();
  const results = await resultsPromise;

  assert.deepEqual(events, ['ctrip:start', 'ctrip:end', 'ihg:start', 'ihg:end']);
  assert.deepEqual(results.map((result) => result.provider), ['ctrip', 'ihg']);
});

function provider(name: ProviderName, queryBody: () => Promise<void>): HotelPriceProvider {
  return {
    name,
    async query(input: PriceQuery): Promise<HotelPriceResult> {
      await queryBody();
      return {
        provider: name,
        hotelName: input.hotelName,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        available: true,
        status: 'success',
        queriedAt: new Date().toISOString(),
      };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await settleMicrotasks();
  }

  throw new Error('condition was not met');
}

function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
