import { BrowserPool } from '../browser/browserPool.js';
import { CtripProvider } from '../modules/ctrip/CtripProvider.js';
import { HyattProvider } from '../modules/hyatt/HyattProvider.js';
import { IhgProvider } from '../modules/ihg/IhgProvider.js';
import { MarriottProvider } from '../modules/marriott/MarriottProvider.js';
import type { HotelPriceProvider, PriceQuery, ProviderName } from '../modules/base/types.js';

type Args = {
  provider?: ProviderName | 'all';
  hotel?: string;
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  rooms?: number;
};

const args = parseArgs(process.argv.slice(2));

if (!args.provider || !args.hotel || !args.checkIn || !args.checkOut) {
  console.error([
    'Usage:',
    '  npm run debug:provider -- --provider marriott --hotel "Shanghai Marriott Marquis City Centre" --checkIn 2026-07-01 --checkOut 2026-07-02',
    '',
    'Providers:',
    '  ctrip | hyatt | ihg | marriott | all',
  ].join('\n'));
  process.exit(1);
}

const input: PriceQuery = {
  hotelName: args.hotel,
  checkIn: args.checkIn,
  checkOut: args.checkOut,
  adults: args.adults ?? 2,
  rooms: args.rooms ?? 1,
  children: 0,
};

const browserPool = new BrowserPool();

try {
  const providers = createProviders(browserPool, args.provider);
  const results = [];

  for (const provider of providers) {
    console.log(`\n[${provider.name}] querying ${input.hotelName}`);
    const result = await provider.query(input);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  console.log('\nDone. Failure screenshots are saved under .artifacts/<provider>/ when available.');
} finally {
  await browserPool.close();
}

function createProviders(browserPool: BrowserPool, provider: ProviderName | 'all'): HotelPriceProvider[] {
  const all = {
    ctrip: new CtripProvider(browserPool),
    hyatt: new HyattProvider(browserPool),
    ihg: new IhgProvider(browserPool),
    marriott: new MarriottProvider(browserPool),
  };

  if (provider === 'all') {
    return [all.ctrip, all.hyatt, all.ihg, all.marriott];
  }

  return [all[provider]];
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key.startsWith('--') || value === undefined) {
      continue;
    }

    index += 1;

    switch (key) {
      case '--provider':
        parsed.provider = value as Args['provider'];
        break;
      case '--hotel':
        parsed.hotel = value;
        break;
      case '--checkIn':
        parsed.checkIn = value;
        break;
      case '--checkOut':
        parsed.checkOut = value;
        break;
      case '--adults':
        parsed.adults = Number(value);
        break;
      case '--rooms':
        parsed.rooms = Number(value);
        break;
      default:
        break;
    }
  }

  return parsed;
}
