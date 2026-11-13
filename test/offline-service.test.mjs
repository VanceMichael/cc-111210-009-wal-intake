import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('离线接收接口走完整流水线并可查询发布版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'svc-offline-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const response = await fetch(service.url + '/offline/intake');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.receipt.batch, 'field-001');
    assert.equal(body.receipt.business.rowCount, 2); // 演练源主库 1 行 + WAL 1 个提交

    const rowsResponse = await fetch(service.url + '/offline/rows');
    assert.equal(rowsResponse.status, 200);
    const rows = (await rowsResponse.json()).rows;
    assert.deepEqual(rows.map(row => row.id), [1, 2]);

    const current = await (await fetch(service.url + '/offline/current')).json();
    assert.equal(current.pointer.batch, 'field-001');
  } finally {
    await service.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('同批次重传返回 duplicated，错盐 WAL 被拒绝并保留证据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'svc-dup-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    await fetch(service.url + '/offline/intake');
    const again = await (await fetch(service.url + '/offline/intake')).json();
    assert.equal(again.duplicated, true);

    const wrong = await fetch(service.url + '/offline/intake?walVariant=wrong-wal');
    assert.equal(wrong.status, 422);
    const wrongBody = await wrong.json();
    assert.equal(wrongBody.ok, false);
    // 错盐 WAL 首先在描述文件摘要核对处被拦截（首要防线），其次才是格式级盐值/校验和。
    assert.match(wrongBody.error, /摘要不符|校验和|盐值/);
    assert.ok(wrongBody.evidence);

    const evidence = await (await fetch(service.url + '/offline/evidence')).json();
    assert.ok(evidence.failures.length >= 1);
    // 上一版仍可查询
    const rows = (await (await fetch(service.url + '/offline/rows')).json()).rows;
    assert.equal(rows.length, 2);
  } finally {
    await service.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
