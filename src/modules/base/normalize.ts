import type { HotelPriceResult, PriceQuery, ProviderName, RateCandidate } from './types.js';

export function successResult(
  provider: ProviderName,
  input: PriceQuery,
  candidate: RateCandidate,
  sourceUrl?: string,
  matchedHotelName?: string,
  matchConfidence?: number,
): HotelPriceResult {
  return {
    provider,
    hotelName: input.hotelName,
    matchedHotelName,
    matchConfidence,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    available: true,
    lowestPrice: candidate.price,
    ...candidate,
    sourceUrl,
    status: 'success',
    queriedAt: new Date().toISOString(),
  };
}

export function unavailableResult(
  provider: ProviderName,
  input: PriceQuery,
  status: HotelPriceResult['status'],
  errorMessage?: string,
  sourceUrl?: string,
  artifactPath?: string,
): HotelPriceResult {
  return {
    provider,
    hotelName: input.hotelName,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    available: false,
    sourceUrl,
    status,
    errorMessage,
    artifactPath,
    queriedAt: new Date().toISOString(),
  };
}

export function parsePrice(text: string): { price?: number; currency?: string } {
  const normalized = text.replace(/\s+/g, ' ');
  const amount = normalized.match(/(?:￥|¥|CNY|RMB|USD|\$|EUR|€|GBP|£)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  if (!amount) {
    return {};
  }

  const currency = normalized.includes('$') || /USD/i.test(normalized)
    ? 'USD'
    : normalized.includes('€') || /EUR/i.test(normalized)
      ? 'EUR'
      : normalized.includes('£') || /GBP/i.test(normalized)
        ? 'GBP'
        : /CNY|RMB|￥|¥/i.test(normalized)
          ? 'CNY'
          : undefined;

  return {
    price: Number(amount[1].replace(/,/g, '')),
    currency,
  };
}

export function nameConfidence(query: string, candidate: string): number {
  const left = normalizeName(query);
  const right = normalizeName(candidate);

  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (right.includes(left) || left.includes(right)) {
    return 0.9;
  }

  const queryChars = Array.from(new Set(left));
  const hits = queryChars.filter((char) => right.includes(char)).length;
  return hits / queryChars.length;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s·.,，。()（）\-_/]/g, '')
    .replace(/hotel|resort|酒店|饭店|度假村|公寓/g, '');
}
