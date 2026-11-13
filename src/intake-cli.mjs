#!/usr/bin/env node
// 离线接收命令行：从独立交付目录读取三份原始字节，写入接收目录并输出回执。
// 用法：node src/intake-cli.mjs --delivery <交付目录> --data <接收目录>
// 交付目录只读打开；接收目录不会成为数据库运行目录。
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { Intake } from './intake.mjs';
import { MANIFEST_NAME } from './manifest.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length) throw new Error(`参数不完整：${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  if (!args.delivery || !args.data) throw new Error('必须提供 --delivery 与 --data');
  return args;
}

async function loadDelivery(deliveryDir) {
  const absolute = isAbsolute(deliveryDir) ? deliveryDir : resolve(process.cwd(), deliveryDir);
  const names = await readdir(absolute);
  if (!names.includes(MANIFEST_NAME)) throw new Error(`交付目录缺少 ${MANIFEST_NAME}`);
  const delivery = [];
  for (const name of names) {
    // 只读取普通文件，拒绝子目录与隐藏文件。
    if (name.startsWith('.')) continue;
    delivery.push([name, await readFile(join(absolute, name))]);
  }
  return { absolute, delivery };
}

async function main() {
  const args = parseArgs(process.argv);
  const { absolute, delivery } = await loadDelivery(args.delivery);
  const before = new Map(delivery.map(([name, bytes]) => [name, bytes.length]));
  const intake = new Intake({
    directory: resolve(args.data),
    // 演练/测试钩子：在暂存完成、原子切换发布之前退出，模拟进程崩溃。
    beforeSwitch: process.env.INTAKE_CRASH_BEFORE_SWITCH === '1'
      ? stageDir => { process.stderr.write(`模拟切换前退出，暂存保留于 ${stageDir}\n`); process.exit(42); }
      : undefined,
  });
  try {
    const result = await intake.receive(delivery);
    await intake.assertNoRuntimeArtifacts();
    console.log(JSON.stringify({
      ok: true,
      duplicated: result.duplicated,
      deliveryDir: absolute,
      batch: result.receipt.batch,
      deliveryDigest: result.receipt.deliveryDigest,
      wal: result.receipt.wal,
      business: result.receipt.business,
      sourceBytesUnchanged: delivery.every(([name, bytes]) => bytes.length === before.get(name)),
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, code: error.code ?? null, evidence: error.evidence ?? null }, null, 2));
    process.exitCode = 1;
  }
}

await main();
