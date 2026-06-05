import type { HotelPriceProvider, HotelPriceResult, PriceQuery } from '../modules/base/types.js';

export class PriceQueryService {
  constructor(private readonly providers: HotelPriceProvider[]) {}

  async queryAll(input: PriceQuery): Promise<HotelPriceResult[]> {
    const settled = await Promise.allSettled(
      this.providers.map(async (provider) => provider.query(input)),
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
