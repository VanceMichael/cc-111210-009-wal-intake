import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory });
  const response = await fetch(service.url + '/receive?key=demo');
  const result = await response.json();
  console.log(JSON.stringify({ source: source.url, status: response.status, receipt: result }, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
