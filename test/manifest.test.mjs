import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, parseManifest, verifyFiles, sha256, MAIN_NAME, WAL_NAME, MANIFEST_NAME } from '../src/manifest.mjs';

const main = Buffer.from('main-db-bytes');
const wal = Buffer.from('wal-bytes');

function sampleManifest(overrides = {}) {
  return buildManifest({
    batch: 'b-1',
    pageSize: 4096,
    walSalt: [11, 22],
    files: [{ name: MAIN_NAME, bytes: main }, { name: WAL_NAME, bytes: wal }],
    ...overrides,
  });
}

test('构造与解析往返一致，包含页大小、盐值与文件摘要', () => {
  const manifest = sampleManifest();
  const parsed = parseManifest(Buffer.from(JSON.stringify(manifest)));
  assert.equal(parsed.batch, 'b-1');
  assert.equal(parsed.pageSize, 4096);
  assert.deepEqual(parsed.walSalt, [11, 22]);
  assert.equal(parsed.files[0].sha256, sha256(main));
});

test('非法批次号、页大小、摘要被拒绝', () => {
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify(sampleManifest({ batch: '../bad' })))), /批次号/);
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify(sampleManifest({ pageSize: 4000 })))), /页大小/);
  const badDigest = sampleManifest();
  badDigest.files[0].sha256 = 'z'.repeat(64);
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify(badDigest))), /SHA256/);
  const missing = sampleManifest();
  missing.files = missing.files.filter(file => file.name !== WAL_NAME);
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify(missing))), /必须同时声明主库与 WAL/);
});

test('verifyFiles 通过匹配的大小与摘要，拒绝篡改与多余文件', () => {
  const manifest = sampleManifest();
  const verified = verifyFiles(manifest, new Map([[MAIN_NAME, main], [WAL_NAME, wal]]));
  assert.equal(verified[MAIN_NAME], main);

  const tampered = Buffer.from(main);
  tampered[0] ^= 1;
  assert.throws(
    () => verifyFiles(manifest, new Map([[MAIN_NAME, tampered], [WAL_NAME, wal]])),
    /摘要不符/,
  );
  assert.throws(
    () => verifyFiles(manifest, new Map([[MAIN_NAME, main], [WAL_NAME, wal], ['extra.bin', Buffer.from('x')]])),
    /未声明的文件/,
  );
  assert.throws(
    () => verifyFiles(manifest, new Map([[MAIN_NAME, main]])),
    /文件缺失/,
  );
});

test('MANIFEST_NAME 常量即描述文件名', () => {
  assert.equal(MANIFEST_NAME, 'manifest.json');
});
