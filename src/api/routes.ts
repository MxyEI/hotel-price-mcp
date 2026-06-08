import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser/browserPool.js';
import type { ManualBrowserService, ManualBrowserSession } from '../browser/manualBrowserService.js';
import type { PriceQueryService } from '../services/PriceQueryService.js';
import type { InMemoryPriceRepository } from '../storage/priceRepository.js';
import type { ProxyConfigService } from '../services/ProxyConfigService.js';

const providerNameSchema = z.enum(['ctrip', 'ihg', 'marriott']);

const priceQuerySchema = z.object({
  hotelName: z.string().trim().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms: z.coerce.number().int().positive().default(1),
  adults: z.coerce.number().int().positive().default(2),
  children: z.coerce.number().int().min(0).default(0),
  locale: z.string().optional(),
  currency: z.string().optional(),
  providers: z.array(providerNameSchema).optional(),
  keepBrowserOpen: z.boolean().optional().default(true),
});

export async function registerRoutes(
  app: FastifyInstance,
  priceQueryService: PriceQueryService,
  repository: InMemoryPriceRepository,
  manualBrowserService: ManualBrowserService,
  proxyConfigService: ProxyConfigService,
  browserPool: BrowserPool,
): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.get('/providers', async () => ({
    providers: priceQueryService.availableProviders,
  }));

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

  app.post('/manual-browser/start', async (request, reply) => {
    const parsed = z.object({
      provider: z.string().optional(),
      targetUrl: z.string().url().optional(),
      hotelName: z.string().trim().optional(),
      checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      rooms: z.coerce.number().int().positive().optional(),
      adults: z.coerce.number().int().positive().optional(),
      children: z.coerce.number().int().min(0).optional(),
    }).safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      });
    }

    if (parsed.data.checkIn && parsed.data.checkOut && new Date(parsed.data.checkOut) <= new Date(parsed.data.checkIn)) {
      return reply.code(400).send({
        error: 'invalid_date_range',
        message: 'checkOut must be later than checkIn',
      });
    }

    try {
      const session = await manualBrowserService.start(parsed.data);
      return toManualBrowserResponse(session);
    } catch (error) {
      return reply.code(500).send({
        error: 'browser_start_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/manual-browser/sessions', async () => ({
    sessions: manualBrowserService.list().map(toManualBrowserResponse),
  }));

  app.get('/manual-browser/status/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const session = manualBrowserService.get(params.id);
    if (!session) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return toManualBrowserResponse(session);
  });

  app.post('/manual-browser/close/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const closed = await manualBrowserService.close(params.id);
    if (!closed) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return { success: true };
  });

  // --- Browser pool (查价浏览器) ---

  app.get('/browsers', async () => ({
    count: browserPool.size,
  }));

  app.post('/browsers/close-all', async () => {
    await browserPool.close();
    return { success: true, remaining: browserPool.size };
  });

  // --- Proxy config endpoints ---

  app.get('/proxy', async () => proxyConfigService.get());

  app.put('/proxy', async (request, reply) => {
    const parsed = z.object({
      url: z.string().trim().optional(),
      enabled: z.boolean().optional(),
      extractUrl: z.string().trim().optional(),
    }).safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      });
    }

    proxyConfigService.update(parsed.data);
    return proxyConfigService.get();
  });

  app.post('/proxy/extract', async (_request, reply) => {
    try {
      const result = await proxyConfigService.extract();
      return result;
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/proxy/test', async (request, reply) => {
    try {
      const result = await proxyConfigService.test();
      return result;
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function toManualBrowserResponse(session: ManualBrowserSession) {
  return {
    id: session.id,
    status: session.status,
    provider: session.provider,
    targetUrl: session.targetUrl,
    currentUrl: session.currentUrl,
    fingerprintSeed: session.fingerprintSeed,
    profileDir: session.profileDir,
    startedAt: session.startedAt,
    closedAt: session.closedAt,
    errorMessage: session.errorMessage,
  };
}
