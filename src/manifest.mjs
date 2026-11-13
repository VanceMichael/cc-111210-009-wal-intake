// 交付描述文件（manifest）：声明批次、SQLite 页大小与每份交付文件的大小和 SHA256。
// 主库与 WAL 的业务归属首先依赖描述文件的摘要绑定——源库没有可自证“WAL 批次”的字段，
// 不得声称仅凭 SQLite 主库头就能证明 WAL 来源。
import { createHash } from 'node:crypto';

export const MAIN_NAME = 'main.sqlite';
export const WAL_NAME = 'main.sqlite-wal';
export const MANIFEST_NAME = 'manifest.json';
const BATCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 由交付字节构造描述文件（演练来源与测试使用；现场由授权导出程序生成）。
// walSalt 来自导出时真实 WAL 头的两个盐值字，供接收侧在摘要之外再做格式级盐值核对。
export function buildManifest({ batch, pageSize, files, walSalt }) {
  if (!BATCH_PATTERN.test(batch)) throw new Error('批次号格式无效');
  if (!Number.isInteger(pageSize) || pageSize < 512) throw new Error('页大小声明无效');
  if (walSalt && (!Number.isInteger(walSalt[0]) || !Number.isInteger(walSalt[1]))) {
    throw new Error('WAL 盐值声明无效');
  }
  return {
    format: 'inspection-delivery/1',
    batch,
    pageSize,
    walSalt: walSalt ? [walSalt[0], walSalt[1]] : undefined,
    files: files.map(({ name, bytes }) => {
      if (!Buffer.isBuffer(bytes)) throw new Error(`文件 ${name} 必须是字节`);
      return { name, size: bytes.length, sha256: sha256(bytes) };
    }),
  };
}

// 严格解析外部交来的描述文件，拒绝多余/缺失文件声明与非法字段。
export function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text.toString('utf8'));
  } catch {
    throw new Error('描述文件不是合法 JSON');
  }
  if (manifest === null || typeof manifest !== 'object') throw new Error('描述文件结构无效');
  if (manifest.format !== 'inspection-delivery/1') throw new Error('描述文件格式版本不受支持');
  if (typeof manifest.batch !== 'string' || !BATCH_PATTERN.test(manifest.batch)) {
    throw new Error('描述文件批次号缺失或格式无效');
  }
  if (!Number.isInteger(manifest.pageSize) || manifest.pageSize < 512 || (manifest.pageSize & (manifest.pageSize - 1)) !== 0) {
    throw new Error('描述文件页大小缺失或非法');
  }
  if (manifest.walSalt !== undefined && (
    !Array.isArray(manifest.walSalt) || manifest.walSalt.length !== 2
    || !manifest.walSalt.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff))) {
    throw new Error('描述文件 WAL 盐值声明非法');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('描述文件未声明任何文件');
  const names = new Set();
  for (const entry of manifest.files) {
    if (entry === null || typeof entry !== 'object') throw new Error('描述文件条目无效');
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(entry.name)) {
      throw new Error('描述文件中的文件名非法');
    }
    if (names.has(entry.name)) throw new Error(`描述文件重复声明文件：${entry.name}`);
    names.add(entry.name);
    if (!Number.isInteger(entry.size) || entry.size < 0) throw new Error(`文件 ${entry.name} 大小声明非法`);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`文件 ${entry.name} 的 SHA256 声明非法`);
    }
  }
  if (!names.has(MAIN_NAME) || !names.has(WAL_NAME)) {
    throw new Error('描述文件必须同时声明主库与 WAL');
  }
  return manifest;
}

// 逐文件核对大小与 SHA256。任何不一致都在打开数据库之前拒绝。
export function verifyFiles(manifest, delivered) {
  const declaredNames = new Set(manifest.files.map(file => file.name));
  for (const name of delivered.keys()) {
    if (!declaredNames.has(name)) throw new Error(`交付目录存在描述文件未声明的文件：${name}`);
  }
  const verified = {};
  for (const declaration of manifest.files) {
    const bytes = delivered.get(declaration.name);
    if (!bytes) throw new Error(`描述文件声明的文件缺失：${declaration.name}`);
    if (bytes.length !== declaration.size) {
      throw new Error(`文件 ${declaration.name} 大小不符：实际 ${bytes.length}，声明 ${declaration.size}`);
    }
    const actual = sha256(bytes);
    if (actual !== declaration.sha256) {
      throw new Error(`文件 ${declaration.name} 摘要不符：实际 ${actual}，声明 ${declaration.sha256}`);
    }
    verified[declaration.name] = bytes;
  }
  return verified;
}
