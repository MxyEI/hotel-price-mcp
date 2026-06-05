import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PriceQueryService } from '../services/PriceQueryService.js';
import type { InMemoryPriceRepository } from '../storage/priceRepository.js';

const priceQuerySchema = z.object({
  hotelName: z.string().trim().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms: z.coerce.number().int().positive().default(1),
  adults: z.coerce.number().int().positive().default(2),
  children: z.coerce.number().int().min(0).default(0),
  locale: z.string().optional(),
  currency: z.string().optional(),
});

export async function registerRoutes(
  app: FastifyInstance,
  priceQueryService: PriceQueryService,
  repository: InMemoryPriceRepository,
): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.post('/price/query', async (request, reply) => {
    const parsed = priceQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      });
    }

    if (new Date(parsed.data.checkOut) <= new Date(parsed.data.checkIn)) {
      return reply.code(400).send({
        error: 'invalid_date_range',
        message: 'checkOut must be later than checkIn',
      });
    }

    const results = await priceQueryService.queryAll(parsed.data);
    const record = repository.save(parsed.data, results);

    return {
      queryId: record.id,
      results,
    };
  });

  app.get('/price/query/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const record = repository.get(params.id);

    if (!record) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return record;
  });
}
