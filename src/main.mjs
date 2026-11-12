import { startService } from './service.mjs';
import { startFixture } from '../fixtures/source.mjs';
const fixture = await startFixture();
const service = await startService({ source: fixture.url, directory: process.env.DATA_DIR ?? '/tmp/capture-receipts', port: Number(process.env.PORT ?? 3000) });
console.log(JSON.stringify({ service: service.url, source: fixture.url }));
const close = async () => { await service.close(); await fixture.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
