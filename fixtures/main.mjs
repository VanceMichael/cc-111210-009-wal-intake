import { startFixture } from './source.mjs';
const source = await startFixture();
console.log(JSON.stringify({ source: source.url }));
const close = async () => { await source.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
