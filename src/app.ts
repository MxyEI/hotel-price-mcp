import cors from '@fastify/cors';
import Fastify from 'fastify';
import { BrowserPool } from './browser/browserPool.js';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { CtripProvider } from './modules/ctrip/CtripProvider.js';
import { IhgProvider } from './modules/ihg/IhgProvider.js';
import { MarriottProvider } from './modules/marriott/MarriottProvider.js';
import { PriceQueryService } from './services/PriceQueryService.js';
import { InMemoryPriceRepository } from './storage/priceRepository.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
  },
});

const browserPool = new BrowserPool();
const providers = [
  new CtripProvider(browserPool),
  new IhgProvider(browserPool),
  new MarriottProvider(browserPool),
];
const priceQueryService = new PriceQueryService(providers);
const repository = new InMemoryPriceRepository();

await app.register(cors, { origin: true });
await registerRoutes(app, priceQueryService, repository);

const shutdown = async (): Promise<void> => {
  await browserPool.close();
  await app.close();
};

process.once('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });
