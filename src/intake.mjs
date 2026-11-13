// 只读来源的离线接收编排。
// 流水线：描述文件核对 → 文件摘要核对 → 主库头核对 → WAL 头/盐值/帧校验和/提交边界校验
//        → 独立工作副本应用已提交帧 → SQLite 完整性检查 → 业务表校验 → 暂存 → 原子切换发布。
// 接收目录只存放证据、工作副本与发布版本，从不在其中以读写方式打开任何数据库，
// 也绝不恢复写入交来的主库（DatabaseSync 只以 readOnly 打开工作副本/发布版本）。
import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseManifest, verifyFiles, sha256, MAIN_NAME, WAL_NAME, MANIFEST_NAME } from './manifest.mjs';
import { parseWal, applyCommitted } from './wal.mjs';

const STAGE_PREFIX = '.stage-';
const WORK_PREFIX = '.work-';

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// 整包指纹：描述文件原文与其绑定的全部文件摘要。同批次重传据此判定内容是否等价。
function computeDeliveryDigest(manifestBytes, manifest) {
  const hash = createHash('sha256');
  hash.update(manifestBytes);
  for (const file of manifest.files) hash.update(file.sha256);
  return hash.digest('hex');
}

// 主库头核对：魔数、页大小与描述文件一致、声明页数与文件长度自洽。
export function readMainHeader(bytes, declaredPageSize) {
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000') {
    throw new Error('主库文件头无效：不是 SQLite 数据库');
  }
  const rawPageSize = bytes.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (pageSize !== declaredPageSize) {
    throw new Error(`页大小不一致：主库头 ${pageSize}，描述文件 ${declaredPageSize}`);
  }
  const headerPages = bytes.readUInt32BE(28);
  if (headerPages !== 0 && headerPages * pageSize !== bytes.length) {
    throw new Error(`主库长度与头部页数不符：${bytes.length} 字节 vs ${headerPages} 页`);
  }
  return { pageSize, headerPages, changeCounter: bytes.readUInt32BE(24), sizeValidCounter: bytes.readUInt32BE(92) };
}

// 工作副本上的 SQLite 完整性检查与业务表校验，全程只读。
// immutable=1 告知 SQLite 文件不会被任何进程更改，连 -shm/-wal 都不会创建，
// 保证接收目录不会成为数据库运行目录。
function openImmutable(path) {
  const uri = pathToFileURL(path).href + '?immutable=1';
  return new DatabaseSync(uri, { readOnly: true });
}

function validateQueryable(path) {
  const db = openImmutable(path);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`SQLite 完整性检查失败：${JSON.stringify(integrity)}`);
    }
    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inspections'").get();
    if (!tableRow) throw new Error('业务表校验失败：缺少 inspections 表');
    const columns = db.prepare('PRAGMA table_info(inspections)').all().map(column => column.name);
    for (const required of ['id', 'location', 'note']) {
      if (!columns.includes(required)) throw new Error(`业务表校验失败：inspections 缺少列 ${required}`);
    }
    const rows = db.prepare('SELECT id, location, note FROM inspections ORDER BY id').all();
    return { rowCount: rows.length, rows };
  } finally {
    db.close();
  }
}

export class Intake {
  constructor({ directory, now = () => new Date().toISOString(), beforeSwitch }) {
    if (!directory) throw new Error('接收目录未配置');
    this.root = directory;
    this.now = now;
    this.beforeSwitch = beforeSwitch;
    this.receivedDir = join(directory, 'received');
    this.currentLink = join(directory, 'current.json');
    this.failuresDir = join(directory, 'failures');
    this.conflictsDir = join(directory, 'conflicts');
    // 进程内按批次串行化，避免同批次并发接收同时越过“无现存回执”检查。
    this.locks = new Map();
  }

  async #withBatchLock(batch, task) {
    while (this.locks.has(batch)) await this.locks.get(batch);
    let release;
    const locked = new Promise(resolve => { release = resolve; });
    this.locks.set(batch, locked);
    try {
      return await task();
    } finally {
      this.locks.delete(batch);
      release();
    }
  }

  async prepare() {
    await mkdir(this.receivedDir, { recursive: true });
    await mkdir(this.failuresDir, { recursive: true });
    await mkdir(this.conflictsDir, { recursive: true });
    await this.#sweepStaging();
  }

  // 清理上一轮在切换前退出遗留的暂存/工作目录（证据与已发布版本不受影响）。
  async #sweepStaging() {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && (entry.name.startsWith(STAGE_PREFIX) || entry.name.startsWith(WORK_PREFIX)))
      .map(entry => rm(join(this.root, entry.name), { recursive: true, force: true })));
  }

  async #readReceipt(batch) {
    try {
      return JSON.parse(await readFile(join(this.receivedDir, batch, 'receipt.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 失败留证：把原始交付字节、描述文件与失败原因封存，绝不影响上一版发布数据。
  async #preserveEvidence(kind, batch, delivery, reason) {
    const stamp = this.now().replace(/[:.]/g, '-');
    const evidenceDir = join(this.root, kind, `${batch}--${stamp}--${process.pid}`);
    await mkdir(evidenceDir, { recursive: true });
    for (const [name, bytes] of delivery) {
      await writeFile(join(evidenceDir, name), bytes, { flag: 'wx' });
    }
    await writeFile(join(evidenceDir, 'failure.json'), JSON.stringify({
      batch, reason, at: this.now(), files: [...delivery.keys()],
    }, null, 2), { flag: 'wx' });
    return evidenceDir;
  }

  // 主入口：delivery 为 [文件名, Buffer][]（含 manifest/main/wal 三份）。
  // 同批次同内容重传返回同一份接收结果；同批次不同内容冲突隔离并留证。
  async receive(delivery) {
    await this.prepare();
    const map = new Map(delivery);
    let manifest;
    let verified;
    let deliveryDigest;
    try {
      const manifestBytes = map.get(MANIFEST_NAME);
      if (!manifestBytes) throw new Error('缺少交付描述文件 manifest.json');
      manifest = parseManifest(manifestBytes);
      const fileEntries = [...map].filter(([name]) => name !== MANIFEST_NAME);
      if (manifest.files.length !== fileEntries.length) {
        throw new Error('交付文件集合与描述文件声明数量不一致');
      }
      verified = verifyFiles(manifest, new Map(fileEntries));
      deliveryDigest = computeDeliveryDigest(manifestBytes, manifest);
    } catch (error) {
      const batch = manifest?.batch ?? 'unknown-batch';
      const evidence = await this.#preserveEvidence('failures', batch, map, error.message);
      throw Object.assign(new Error(`交付核对失败：${error.message}`), { code: 'INTAKE_VERIFY_FAILED', evidence });
    }

    const batch = manifest.batch;
    return this.#withBatchLock(batch, () => this.#receiveVerified({
      batch, map, manifest, verified, deliveryDigest,
    }));
  }

  // 调用方已持有该批次的进程内锁。
  async #receiveVerified({ batch, map, manifest, verified, deliveryDigest }) {
    const existing = await this.#readReceipt(batch);
    if (existing) {
      if (existing.deliveryDigest === deliveryDigest) {
        return { duplicated: true, receipt: existing };
      }
      const evidence = await this.#preserveEvidence('conflicts', batch, map,
        `同批次号内容不同：已接收指纹 ${existing.deliveryDigest.slice(0, 12)}，本次 ${deliveryDigest.slice(0, 12)}`);
      throw Object.assign(new Error(`批次 ${batch} 内容冲突，已隔离保留证据`), {
        code: 'INTAKE_CONFLICT', evidence, existingReceipt: existing,
      });
    }

    const workDir = join(this.root, `${WORK_PREFIX}${batch}-${process.pid}`);
    const stageDir = join(this.root, `${STAGE_PREFIX}${batch}-${process.pid}`);
    let switching = false;
    try {
      await mkdir(workDir, { recursive: false });
      const main = verified[MAIN_NAME];
      const wal = verified[WAL_NAME];
      const header = readMainHeader(main, manifest.pageSize);
      const expectedSalt = manifest.walSalt;
      const parsed = parseWal(wal, { expectedSalt });
      if (parsed.pageSize !== header.pageSize) {
        throw new Error(`WAL 页大小 ${parsed.pageSize} 与主库页大小 ${header.pageSize} 不一致`);
      }
      const walSummary = {
        salt: parsed.salt,
        frameCount: parsed.frameCount,
        lastCommitFrame: parsed.lastCommit,
        trailingBytes: parsed.trailingBytes,
        uncommittedFrames: parsed.frameCount - parsed.lastCommit - 1,
      };
      const applied = applyCommitted(main, wal, parsed);

      const workCopy = join(workDir, 'received.sqlite');
      await writeFile(workCopy, applied.bytes, { flag: 'wx' });
      const business = validateQueryable(workCopy);

      // 完整性检查与业务表校验通过后才允许进入暂存区。
      await mkdir(stageDir, { recursive: false });
      const receipt = {
        batch,
        receivedAt: this.now(),
        deliveryDigest,
        files: Object.fromEntries(manifest.files.map(file => [file.name, { size: file.size, sha256: file.sha256 }])),
        pageSize: manifest.pageSize,
        wal: walSummary,
        appliedFrames: applied.appliedFrames,
        committedPages: applied.committedPages,
        receivedFile: { name: 'received.sqlite', size: applied.bytes.length, sha256: sha256(applied.bytes) },
        business: { rowCount: business.rowCount },
      };
      receipt.receiptDigest = digestJson({ ...receipt, receiptDigest: undefined });
      await writeFile(join(stageDir, 'received.sqlite'), applied.bytes, { flag: 'wx' });
      await writeFile(join(stageDir, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
      await mkdir(join(stageDir, 'source'), { recursive: true });
      for (const [name, bytes] of map) {
        await writeFile(join(stageDir, 'source', name), bytes, { flag: 'wx' });
      }

      // 原子发布：同文件系统 rename 为原子操作；先发布批次目录，再切换 current 指针。
      // beforeSwitch 钩子用于演练“切换前进程退出”：此刻暂存已完整，发布尚未发生。
      switching = true;
      if (this.beforeSwitch) await this.beforeSwitch(stageDir);
      const target = join(this.receivedDir, batch);
      await rename(stageDir, target);
      const pointer = {
        batch,
        publishedAt: this.now(),
        receipt: join('received', batch, 'receipt.json'),
        receivedFile: join('received', batch, 'received.sqlite'),
        deliveryDigest,
      };
      const pointerTmp = join(this.receivedDir, `.current-${process.pid}-${Date.now()}.json`);
      await writeFile(pointerTmp, JSON.stringify(pointer, null, 2), { flag: 'wx' });
      await rename(pointerTmp, this.currentLink);
      await rm(workDir, { recursive: true, force: true });
      return { duplicated: false, receipt: await this.#readReceipt(batch) };
    } catch (error) {
      // 切换阶段抛错模拟进程硬退出：保留工作/暂存目录（下次 prepare 清扫），
      // 只留失败证据并上抛；其余阶段的错误正常清理半成品。
      if (!switching) {
        await rm(workDir, { recursive: true, force: true });
        await rm(stageDir, { recursive: true, force: true });
      }
      const evidence = await this.#preserveEvidence('failures', batch, map, error.message);
      throw Object.assign(new Error(`接收失败：${error.message}`), { code: 'INTAKE_FAILED', evidence });
    }
  }

  // 发布点查询：只读取已切换的版本，失败/暂存不会改变它。
  async current() {
    try {
      const pointer = JSON.parse(await readFile(this.currentLink, 'utf8'));
      const receipt = JSON.parse(await readFile(join(this.root, pointer.receipt), 'utf8'));
      return { pointer, receipt };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async queryCurrent() {
    const current = await this.current();
    if (!current) throw new Error('尚无已发布的接收版本');
    const db = openImmutable(join(this.root, current.pointer.receivedFile));
    try {
      return db.prepare('SELECT id, location, note FROM inspections ORDER BY id').all();
    } finally {
      db.close();
    }
  }

  // 证据目录清单（演示与运维核查使用）。
  async evidence() {
    const list = async directory => {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter(entry => entry.isDirectory()).map(entry => ({ directory, name: entry.name }));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    };
    const [failures, conflicts] = await Promise.all([list(this.failuresDir), list(this.conflictsDir)]);
    return { failures, conflicts };
  }

  // 接收目录绝不允许出现 SQLite 运行产物（-wal/-shm/-journal）。
  // 证据目录与各批次 source/ 下的 main.sqlite-wal 是交来的原始证据，不是运行产物，需排除。
  async assertNoRuntimeArtifacts() {
    const found = [];
    const isRuntime = name => name.endsWith('-shm') || name.endsWith('-journal')
      || (name.endsWith('-wal') && name !== WAL_NAME);
    const walk = async (directory, { evidenceRoot = false } = {}) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          // failures/conflicts 与 source 目录封存的是原始交付字节，整体跳过。
          const isEvidence = evidenceRoot || entry.name === 'source';
          await walk(full, { evidenceRoot: isEvidence });
        } else if (isRuntime(entry.name)) {
          found.push(full);
        }
      }
    };
    await walk(this.root);
    if (found.length) throw new Error(`接收目录出现数据库运行产物：${found.join(', ')}`);
  }
}
