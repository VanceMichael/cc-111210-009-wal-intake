import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listen } from '../src/http.mjs';
import { buildManifest, MAIN_NAME, WAL_NAME } from '../src/manifest.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'field-source-'));
  let db;
  try {
    const path = join(directory, 'field.sqlite');
    db = new DatabaseSync(path);
    db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE inspections(id INTEGER PRIMARY KEY, location TEXT, note TEXT); INSERT INTO inspections VALUES(1,\'A区\',\'已巡检\'); PRAGMA wal_checkpoint(TRUNCATE);');
    const clean = await readFile(path);
    db.exec("INSERT INTO inspections VALUES(2,'B区','需要复查');");
    const main = await readFile(path);
    const wal = await readFile(path + '-wal');
    db.close();
    db = null;
    const files = { [MAIN_NAME]: main, [WAL_NAME]: wal, 'clean.sqlite': clean };
    const manifest = buildManifest({
      batch: 'field-001',
      pageSize: 4096,
      walSalt: [wal.readUInt32BE(16), wal.readUInt32BE(20)],
      files: [{ name: MAIN_NAME, bytes: main }, { name: WAL_NAME, bytes: wal }],
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const server = await listen(async url => {
      if (url.pathname === '/manifest') return { body: manifest };
      if (url.pathname === '/truncated-wal') return { type: 'application/octet-stream', body: wal.subarray(0, wal.length - 11) };
      if (url.pathname === '/wrong-wal') { const wrong = Buffer.from(wal); wrong[16] ^= 1; return { type: 'application/octet-stream', body: wrong }; }
      if (url.pathname === '/' + MAIN_NAME) return { type: 'application/octet-stream', body: main };
      if (url.pathname === '/' + WAL_NAME) return { type: 'application/octet-stream', body: wal };
      if (url.pathname === '/clean.sqlite') return { type: 'application/octet-stream', body: clean };
      if (url.pathname === '/manifest.json') return { type: 'application/json', body: manifestBytes };
      return { status: 404, body: {} };
    });
    return {
      ...server,
      manifest,
      close: async () => { await server.close(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    db?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
