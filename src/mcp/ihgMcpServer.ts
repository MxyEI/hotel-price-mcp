import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserPool } from '../browser/browserPool.js';
import { IhgProvider } from '../modules/ihg/IhgProvider.js';
import type { PriceQuery } from '../modules/base/types.js';

const querySchema = z.object({
  hotelName: z.string().trim().min(1).describe('IHG hotel name or search keyword, e.g. 西安经开洲际'),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Check-in date in YYYY-MM-DD'),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Check-out date in YYYY-MM-DD'),
  rooms: z.number().int().positive().default(1).describe('Number of rooms'),
  adults: z.number().int().positive().default(2).describe('Number of adult guests'),
  children: z.number().int().min(0).default(0).describe('Number of child guests'),
});

const server = new McpServer({
  name: 'hotel-price-ihg-mcp',
  version: '0.1.0',
});

const browserPool = new BrowserPool();
const ihgProvider = new IhgProvider(browserPool);

server.registerTool(
  'ihg_query_price',
  {
    title: 'Query IHG Hotel Price',
    description: 'Query IHG hotel price by hotel name, check-in date, and check-out date using CloakBrowser and IHG API data.',
    inputSchema: querySchema.shape,
  },
  async (args) => {
    const input: PriceQuery = {
      hotelName: args.hotelName,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      rooms: args.rooms,
      adults: args.adults,
      children: args.children,
    };

    if (new Date(input.checkOut) <= new Date(input.checkIn)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'invalid_date_range',
              message: 'checkOut must be later than checkIn',
            }, null, 2),
          },
        ],
      };
    }

    const result = await ihgProvider.query(input);

    return {
      isError: result.status === 'error' || result.status === 'blocked' || result.status === 'captcha',
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result,
    };
  },
);

const shutdown = async (): Promise<void> => {
  await browserPool.close();
  await server.close();
};

process.once('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});

await server.connect(new StdioServerTransport());
