import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Intake } from '../src/intake.mjs';
import { buildScenarios } from '../fixtures/delivery.mjs';
import { sha256, MANIFEST_NAME, MAIN_NAME, WAL_NAME } from '../src/manifest.mjs';

let scenarios;
let scenarioCleanup;
test.before(async () => {
  const built = await buildScenarios();
  scenarios = built.scenarios;
  scenarioCleanup = built.cleanupAll;
});
test.after(async () => {
  await scenarioCleanup();
});

async function freshDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test('正常交付只采到最后完整提交，未提交尾帧不落地，发布版本可查询', async () => {
  const dataDir = await freshDir('intake-ok-');
  try {
    const intake = new Intake({ directory: dataDir });
    const result = await intake.receive(scenarios.valid.delivery);
    assert.equal(result.duplicated, false);
    assert.equal(result.receipt.business.rowCount, 3);
    assert.equal(result.receipt.wal.uncommittedFrames, 1);
    assert.equal(result.receipt.wal.lastCommitFrame, 1);
    const rows = await intake.queryCurrent();
    assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);
    await intake.assertNoRuntimeArtifacts();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('尾部截断保留前一个完整提交，尾字节记为 trailingBytes', async () => {
  const dataDir = await freshDir('intake-trunc-');
  try {
    const intake = new Intake({ directory: dataDir });
    const result = await intake.receive(scenarios.truncated.delivery);
    assert.equal(result.receipt.business.rowCount, 2);
    assert.equal(result.receipt.wal.trailingBytes, 200);
    assert.equal(result.receipt.wal.lastCommitFrame, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('外来 WAL 盐值冲突被拒绝，证据保留且无发布版本', async () => {
  const dataDir = await freshDir('intake-foreign-');
  try {
    const intake = new Intake({ directory: dataDir });
    await assert.rejects(intake.receive(scenarios['foreign-wal'].delivery), /盐值/);
    assert.equal(await intake.current(), null);
    const evidence = await intake.evidence();
    assert.equal(evidence.failures.length, 1);
    const evidenceFiles = await readdir(join(dataDir, 'failures', evidence.failures[0].name));
    assert.deepEqual(evidenceFiles.sort(), [MANIFEST_NAME, WAL_NAME, MAIN_NAME, 'failure.json'].sort());
    await intake.assertNoRuntimeArtifacts();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('主库摘要不符在打开数据库前拒绝', async () => {
  const dataDir = await freshDir('intake-tamper-');
  try {
    const intake = new Intake({ directory: dataDir });
    await assert.rejects(intake.receive(scenarios['tampered-main'].delivery), /摘要不符/);
    assert.equal(await intake.current(), null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('同批次同内容重传得到相同接收结果，同批次不同内容冲突隔离', async () => {
  const dataDir = await freshDir('intake-dup-');
  try {
    const intake = new Intake({ directory: dataDir });
    const first = await intake.receive(scenarios.valid.delivery);
    const second = await intake.receive(scenarios.valid.delivery);
    assert.equal(second.duplicated, true);
    assert.equal(first.receipt.deliveryDigest, second.receipt.deliveryDigest);
    assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
    // 同批次号、不同内容
    const conflict = new Map(scenarios.valid.delivery);
    const changedWal = Buffer.from(conflict.get(WAL_NAME));
    changedWal[changedWal.length - 1] ^= 1;
    const manifest = JSON.parse(conflict.get(MANIFEST_NAME).toString('utf8'));
    manifest.files.find(file => file.name === WAL_NAME).sha256 = sha256(changedWal);
    manifest.files.find(file => file.name === WAL_NAME).size = changedWal.length;
    conflict.set(WAL_NAME, changedWal);
    conflict.set(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest)));
    await assert.rejects(intake.receive(conflict), /冲突/);
    const evidence = await intake.evidence();
    assert.equal(evidence.conflicts.length, 1);
    // 上一版发布不受影响
    assert.equal((await intake.current()).pointer.batch, 'field-001');
    assert.deepEqual((await intake.queryCurrent()).map(row => row.id), [1, 2, 3]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('失败不影响上一版已发布巡检数据', async () => {
  const dataDir = await freshDir('intake-keep-');
  try {
    const intake = new Intake({ directory: dataDir });
    await intake.receive(scenarios.valid.delivery);
    const before = await intake.current();
    await assert.rejects(intake.receive(scenarios['foreign-wal'].delivery), /盐值/);
    await assert.rejects(intake.receive(scenarios['tampered-main'].delivery), /摘要不符/);
    const after = await intake.current();
    assert.equal(after.pointer.deliveryDigest, before.pointer.deliveryDigest);
    assert.deepEqual((await intake.queryCurrent()).map(row => row.id), [1, 2, 3]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('切换前退出留下暂存，重启清理后上一版不变且可重投', async () => {
  const dataDir = await freshDir('intake-crash-');
  try {
    const intake = new Intake({ directory: dataDir });
    await intake.receive(scenarios.valid.delivery);
    const before = (await intake.current()).pointer.batch;

    // 新批次，在原子切换前抛错，模拟进程退出。
    const crashIntake = new Intake({
      directory: dataDir,
      beforeSwitch: () => { throw new Error('模拟进程退出'); },
    });
    const crashDelivery = new Map(scenarios.truncated.delivery);
    const crashManifest = JSON.parse(crashDelivery.get(MANIFEST_NAME).toString('utf8'));
    crashManifest.batch = 'field-crash';
    crashDelivery.set(MANIFEST_NAME, Buffer.from(JSON.stringify(crashManifest)));
    await assert.rejects(crashIntake.receive(crashDelivery), /模拟进程退出/);

    let entries = await readdir(dataDir);
    assert.ok(entries.some(name => name.startsWith('.stage-')), '暂存目录应保留');
    assert.equal((await intake.current()).pointer.batch, before);

    // 重启：prepare 清理暂存。
    const restarted = new Intake({ directory: dataDir });
    await restarted.prepare();
    entries = await readdir(dataDir);
    assert.ok(!entries.some(name => name.startsWith('.stage-') || name.startsWith('.work-')));
    assert.equal((await restarted.current()).pointer.batch, before);

    // 未发布的批次可重新接收成功。
    const retry = await restarted.receive(crashDelivery);
    assert.equal(retry.duplicated, false);
    assert.equal(retry.receipt.batch, 'field-crash');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('接收全过程不修改来源交付字节', async () => {
  const dataDir = await freshDir('intake-immutable-');
  try {
    const fingerprints = new Map([...scenarios.valid.delivery].map(([name, bytes]) => [name, sha256(bytes)]));
    const intake = new Intake({ directory: dataDir });
    await intake.receive(scenarios.valid.delivery);
    for (const [name, bytes] of scenarios.valid.delivery) {
      assert.equal(sha256(bytes), fingerprints.get(name), `${name} 字节被修改`);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('同批次并发接收被串行化，只发布一版且结果一致', async () => {
  const dataDir = await freshDir('intake-concurrent-');
  try {
    const intake = new Intake({ directory: dataDir });
    const results = await Promise.allSettled([
      intake.receive(scenarios.valid.delivery),
      intake.receive(scenarios.valid.delivery),
      intake.receive(scenarios.valid.delivery),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.equal(fulfilled.length, 3);
    const digests = new Set(fulfilled.map(r => r.receipt.deliveryDigest));
    assert.equal(digests.size, 1);
    // 恰好一个真正写入，其余命中幂等路径。
    assert.ok(fulfilled.some(r => r.duplicated === false));
    const entries = await readdir(join(dataDir, 'received'));
    assert.deepEqual(entries, ['field-001']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('发布的接收版本是自洽 SQLite，源证据原样封存', async () => {
  const dataDir = await freshDir('intake-publish-');
  try {
    const intake = new Intake({ directory: dataDir });
    const { receipt } = await intake.receive(scenarios.valid.delivery);
    const batchDir = join(dataDir, 'received', receipt.batch);
    const sourceDir = join(batchDir, 'source');
    // 源证据与交付字节逐字节一致
    for (const [name, bytes] of scenarios.valid.delivery) {
      assert.ok(await readFile(join(sourceDir, name)).then(b => b.equals(bytes)));
    }
    // 发布文件摘要与回执一致
    const published = await readFile(join(batchDir, 'received.sqlite'));
    assert.equal(sha256(published), receipt.receivedFile.sha256);
    const onDiskReceipt = JSON.parse(await readFile(join(batchDir, 'receipt.json'), 'utf8'));
    assert.equal(onDiskReceipt.receiptDigest, receipt.receiptDigest);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
