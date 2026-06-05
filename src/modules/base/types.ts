export type ProviderName = 'ctrip' | 'ihg' | 'marriott';

export type PriceQuery = {
  hotelName: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  children: number;
  locale?: string;
  currency?: string;
};

export type RateCandidate = {
  roomName?: string;
  rateName?: string;
  price?: number;
  currency?: string;
  taxIncluded?: boolean;
  breakfastIncluded?: boolean;
  cancelPolicy?: string;
  isMemberRate?: boolean;
  isPrepaid?: boolean;
};

export type HotelPriceResult = RateCandidate & {
  provider: ProviderName;
  hotelName: string;
  matchedHotelName?: string;
  matchConfidence?: number;
  checkIn: string;
  checkOut: string;
  available: boolean;
  lowestPrice?: number;
  sourceUrl?: string;
  status: 'success' | 'no_availability' | 'captcha' | 'blocked' | 'hotel_not_found' | 'error';
  errorMessage?: string;
  artifactPath?: string;
  queriedAt: string;
};

export interface HotelPriceProvider {
  name: ProviderName;
  query(input: PriceQuery): Promise<HotelPriceResult>;
}
