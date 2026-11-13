// 离线接收完整演示：
//  1) 正常交付（含未提交尾帧，只采到最后完整提交）
//  2) 提交尾部截断（保留前一个完整提交，尾字节不落地）
//  3) 外来 WAL（盐值与描述声明冲突，拒绝并留证）
//  4) 同批次重复接收（结果一致）与同批次不同内容（冲突隔离）
//  5) 切换前进程退出（暂存被下次启动清理，上一版发布不受影响）
//  6) 全程核对原始交付字节保持不变，接收目录无数据库运行产物。
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Intake } from './intake.mjs';
import { buildScenarios, materialize } from '../fixtures/delivery.mjs';
import { sha256, buildManifest, MANIFEST_NAME, MAIN_NAME, WAL_NAME } from './manifest.mjs';

const line = title => console.log(`\n===== ${title} =====`);
const fingerprint = delivery => new Map([...delivery].map(([name, bytes]) => [name, sha256(bytes)]));

async function runIntake(dataDir, deliveryDir) {
  const child = spawn(process.execPath, [join(process.cwd(), 'src/intake-cli.mjs'), '--delivery', deliveryDir, '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const code = await new Promise(resolve => child.on('close', resolve));
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'intake-demo-'));
  const dataDir = join(workspace, 'data');
  const deliveriesRoot = join(workspace, 'deliveries');
  await mkdir(dataDir, { recursive: true });
  await mkdir(deliveriesRoot, { recursive: true });
  const { scenarios, cleanupAll } = await buildScenarios();
  try {
    // 把每个场景写入独立的全新空目录。
    const dirs = {};
    for (const [key, scenario] of Object.entries(scenarios)) {
      const dir = join(deliveriesRoot, key);
      await materialize(dir, scenario.delivery);
      dirs[key] = dir;
    }
    const originalFingerprints = Object.fromEntries(
      Object.entries(scenarios).map(([key, scenario]) => [key, fingerprint(scenario.delivery)]));

    line('1. 正常交付：未提交尾帧不落地，只采到最后完整提交（期望 3 行）');
    const r1 = await runIntake(dataDir, dirs.valid);
    console.log(r1.stdout);
    const intake = new Intake({ directory: dataDir });
    console.log('发布点查询行：', JSON.stringify(await intake.queryCurrent()));

    line('2. 提交尾部截断：拒绝不完整尾帧，保留前一个完整提交（期望 2 行）');
    const r2 = await runIntake(dataDir, dirs.truncated);
    console.log(r2.stdout);

    line('3. WAL 来自其他主库：盐值冲突，拒绝并保留证据');
    const r3 = await runIntake(dataDir, dirs['foreign-wal']);
    console.log(r3.stdout);
    const evidenceAfter3 = await intake.evidence();
    console.log('失败证据目录：', JSON.stringify(evidenceAfter3.failures, null, 2));

    line('4a. 同批次重复接收：相同交付得到相同接收结果');
    const r4a = await runIntake(dataDir, dirs.valid);
    const r4b = await runIntake(dataDir, dirs.valid);
    const j4a = JSON.parse(r4a.stdout);
    const j4b = JSON.parse(r4b.stdout);
    console.log('第一次 duplicated =', j4a.duplicated, ' 第二次 duplicated =', j4b.duplicated);
    console.log('两次 deliveryDigest 一致：', j4a.deliveryDigest === j4b.deliveryDigest);
    console.log('重复接收后发布点仍指向同一批次：', (await intake.current()).pointer.batch);

    line('4b. 相同批次号、不同内容：冲突隔离，不覆盖上一版');
    const conflictDir = join(deliveriesRoot, 'conflict-same-batch');
    await mkdir(conflictDir, { recursive: false });
    const validMap = new Map(scenarios.valid.delivery);
    const conflictManifest = JSON.parse(validMap.get(MANIFEST_NAME).toString('utf8'));
    conflictManifest.batch = 'field-001'; // 与已接收批次同号
    // 改动 WAL 一个数据字节并重新声明摘要，制造“同批次不同内容”。
    const changedWal = Buffer.from(validMap.get(WAL_NAME));
    changedWal[changedWal.length - 1] ^= 0x01;
    const rebuilt = new Map([
      [MAIN_NAME, validMap.get(MAIN_NAME)],
      [WAL_NAME, changedWal],
    ]);
    const conflict = buildManifest({
      batch: 'field-001', pageSize: 4096,
      walSalt: [changedWal.readUInt32BE(16), changedWal.readUInt32BE(20)],
      files: [
        { name: MAIN_NAME, bytes: rebuilt.get(MAIN_NAME) },
        { name: WAL_NAME, bytes: changedWal },
      ],
    });
    rebuilt.set(MANIFEST_NAME, Buffer.from(JSON.stringify(conflict, null, 2)));
    for (const [name, bytes] of rebuilt) await writeFile(join(conflictDir, name), bytes, { flag: 'wx' });
    const r4conflict = await runIntake(dataDir, conflictDir);
    console.log(r4conflict.stdout);
    console.log('冲突后发布点批次不变：', (await intake.current()).pointer.batch);
    console.log('冲突证据：', JSON.stringify((await intake.evidence()).conflicts, null, 2));

    line('5. 切换前进程退出：真实子进程崩溃，暂存被下次启动清理，上一版数据不变');
    const crashDir = join(deliveriesRoot, 'crash-batch');
    await mkdir(crashDir, { recursive: false });
    // 用截断场景的交付换一个新批次号，制造一个尚未接收过的批次。
    const crashMap = new Map(scenarios.truncated.delivery);
    const crashManifestJson = JSON.parse(crashMap.get(MANIFEST_NAME).toString('utf8'));
    crashManifestJson.batch = 'field-007-crash';
    crashMap.set(MANIFEST_NAME, Buffer.from(JSON.stringify(crashManifestJson, null, 2)));
    for (const [name, bytes] of crashMap) await writeFile(join(crashDir, name), bytes, { flag: 'wx' });
    const beforeCurrent = (await intake.current()).pointer.batch;
    const crashChild = spawn(process.execPath,
      [join(process.cwd(), 'src/intake-cli.mjs'), '--delivery', crashDir, '--data', dataDir],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, INTAKE_CRASH_BEFORE_SWITCH: '1' } });
    const crashStderr = [];
    crashChild.stderr.on('data', chunk => crashStderr.push(chunk));
    const crashCode = await new Promise(resolve => crashChild.on('close', resolve));
    console.log('崩溃子进程退出码：', crashCode, '|', Buffer.concat(crashStderr).toString().trim());
    const dirDuringCrash = await readdir(dataDir);
    console.log('崩溃后、重启前接收目录：', dirDuringCrash);
    console.log('崩溃后发布点批次仍为：', (await intake.current()).pointer.batch, '（期望', beforeCurrent, '）');
    const restarted = new Intake({ directory: dataDir });
    await restarted.prepare(); // 模拟进程重启：清理暂存
    const remaining = await readdir(dataDir);
    console.log('重启后接收目录条目：', remaining);
    console.log('暂存已清理：', !remaining.some(name => name.startsWith('.stage-') || name.startsWith('.work-')));
    console.log('发布点批次保持：', (await restarted.current()).pointer.batch === beforeCurrent);
    // 崩溃的那一批在清理后可重新正常接收（暂存未发布，不构成重复）。
    const retry = await runIntake(dataDir, crashDir);
    console.log('崩溃批次重投后的接收结果：ok =', JSON.parse(retry.stdout).ok,
      'duplicated =', JSON.parse(retry.stdout).duplicated);

    line('6. 原始交付字节不变 + 接收目录无运行产物');
    let allUnchanged = true;
    for (const [key, scenario] of Object.entries(scenarios)) {
      const onDisk = new Map();
      for (const name of await readdir(dirs[key])) {
        onDisk.set(name, await readFile(join(dirs[key], name)));
      }
      for (const [name, originalHash] of originalFingerprints[key]) {
        if (sha256(onDisk.get(name)) !== originalHash) { allUnchanged = false; console.log('被改动：', key, name); }
      }
    }
    console.log('所有交付目录原始字节 SHA256 与接收前一致：', allUnchanged);
    await intake.assertNoRuntimeArtifacts();
    console.log('接收目录不存在 -wal/-shm/-journal 运行产物：true');
    console.log('\n接收目录结构：');
    const tree = async (dir, prefix = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        console.log(prefix + entry.name + (entry.isDirectory() ? '/' : ''));
        if (entry.isDirectory() && prefix.split('/').filter(Boolean).length < 2) {
          await tree(join(dir, entry.name), prefix + '  ');
        }
      }
    };
    await tree(dataDir);

    if (r1.code !== 0 || r2.code !== 0 || r3.code !== 1 || r4conflict.code !== 1) {
      throw new Error('演示退出码不符合预期');
    }
  } finally {
    await cleanupAll();
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
