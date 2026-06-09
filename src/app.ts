import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserPool } from './browser/browserPool.js';
import { ManualBrowserService } from './browser/manualBrowserService.js';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { CtripProvider } from './modules/ctrip/CtripProvider.js';
import { IhgProvider } from './modules/ihg/IhgProvider.js';
import { HyattProvider } from './modules/hyatt/HyattProvider.js';
import { MarriottProvider } from './modules/marriott/MarriottProvider.js';
import { PriceQueryService } from './services/PriceQueryService.js';
import { ProxyConfigService } from './services/ProxyConfigService.js';
import { InMemoryPriceRepository } from './storage/priceRepository.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
  },
});

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPool = new BrowserPool();
const manualBrowserService = new ManualBrowserService();
const proxyConfigService = new ProxyConfigService();
const providers = [
  new CtripProvider(browserPool),
  new HyattProvider(browserPool),
  new IhgProvider(browserPool),
  new MarriottProvider(browserPool),
];
const priceQueryService = new PriceQueryService(providers);
const repository = new InMemoryPriceRepository();

await app.register(cors, { origin: true });
await app.register(fastifyStatic, {
  root: path.join(rootDir, 'public'),
  prefix: '/',
});
await registerRoutes(app, priceQueryService, repository, manualBrowserService, proxyConfigService, browserPool);

const shutdown = async (): Promise<void> => {
  await manualBrowserService.closeAll();
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
