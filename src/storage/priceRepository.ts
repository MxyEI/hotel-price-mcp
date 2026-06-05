import type { HotelPriceResult, PriceQuery } from '../modules/base/types.js';

export type PriceQueryRecord = {
  id: string;
  input: PriceQuery;
  results: HotelPriceResult[];
  createdAt: string;
};

export class InMemoryPriceRepository {
  private readonly records = new Map<string, PriceQueryRecord>();

  save(input: PriceQuery, results: HotelPriceResult[]): PriceQueryRecord {
    const record: PriceQueryRecord = {
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      input,
      results,
      createdAt: new Date().toISOString(),
    };

    this.records.set(record.id, record);
    return record;
  }

  get(id: string): PriceQueryRecord | undefined {
    return this.records.get(id);
  }
}
