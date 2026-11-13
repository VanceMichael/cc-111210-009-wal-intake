// 离线交付演练素材：由真实 SQLite 生成主库与多提交 WAL，再派生出截断、错盐、外来库等场景。
// 每个场景都产出“主库 + WAL + 描述文件”三份交付字节；原始交付字节在接收侧保持不变。
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, MAIN_NAME, WAL_NAME, MANIFEST_NAME, sha256 } from '../src/manifest.mjs';
import { parseWal } from '../src/wal.mjs';

const PAGE_SIZE = 4096;
const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;
const FRAME_SIZE = FRAME_HEADER_SIZE + PAGE_SIZE;

function makeChecksum(littleEndian) {
  return function checksum(buffer, s0 = 0, s1 = 0) {
    for (let offset = 0; offset + 8 <= buffer.length; offset += 8) {
      const word0 = littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
      const word1 = littleEndian ? buffer.readUInt32LE(offset + 4) : buffer.readUInt32BE(offset + 4);
      s0 = (s0 + word0 + s1) >>> 0;
      s1 = (s1 + word1 + s0) >>> 0;
    }
    return [s0 >>> 0, s1 >>> 0];
  };
}

// 在给定 WAL 尾部追加一帧；dbSize 为 0 表示非提交帧。返回新 Buffer。
function appendFrame(wal, pageNumber, pageData, dbSize, { commit = true } = {}) {
  const littleEndian = parseWal(wal).littleEndian;
  const checksum = makeChecksum(littleEndian);
  const salt = [wal.readUInt32BE(16), wal.readUInt32BE(20)];
  let s = checksum(wal.subarray(0, 24));
  const existingFrames = (wal.length - WAL_HEADER_SIZE) / FRAME_SIZE;
  for (let i = 0; i < existingFrames; i++) {
    const offset = WAL_HEADER_SIZE + i * FRAME_SIZE;
    s = checksum(wal.subarray(offset, offset + 8), s[0], s[1]);
    s = checksum(wal.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + PAGE_SIZE), s[0], s[1]);
  }
  const frame = Buffer.alloc(FRAME_SIZE);
  frame.writeUInt32BE(pageNumber, 0);
  frame.writeUInt32BE(commit ? dbSize : 0, 4);
  frame.writeUInt32BE(salt[0], 8);
  frame.writeUInt32BE(salt[1], 12);
  s = checksum(frame.subarray(0, 8), s[0], s[1]);
  pageData.copy(frame, FRAME_HEADER_SIZE);
  s = checksum(frame.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + PAGE_SIZE), s[0], s[1]);
  frame.writeUInt32BE(s[0], 16);
  frame.writeUInt32BE(s[1], 20);
  return Buffer.concat([wal, frame]);
}

// 重写 WAL 头盐与全部帧盐，并重算头/帧校验和，得到一份盐值自洽的 WAL。
function rebaseSalt(wal, salt) {
  const littleEndian = parseWal(wal).littleEndian;
  const checksum = makeChecksum(littleEndian);
  const out = Buffer.from(wal);
  out.writeUInt32BE(salt[0], 16);
  out.writeUInt32BE(salt[1], 20);
  let s = checksum(out.subarray(0, 24));
  out.writeUInt32BE(s[0], 24);
  out.writeUInt32BE(s[1], 28);
  const frames = (out.length - WAL_HEADER_SIZE) / FRAME_SIZE;
  for (let i = 0; i < frames; i++) {
    const offset = WAL_HEADER_SIZE + i * FRAME_SIZE;
    out.writeUInt32BE(salt[0], offset + 8);
    out.writeUInt32BE(salt[1], offset + 12);
    s = checksum(out.subarray(offset, offset + 8), s[0], s[1]);
    s = checksum(out.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + PAGE_SIZE), s[0], s[1]);
    out.writeUInt32BE(s[0], offset + 16);
    out.writeUInt32BE(s[1], offset + 20);
  }
  return out;
}

// 生成现场基础素材：主库含 1 行，WAL 含两个完整提交（第 2、3 行）与一个未提交尾帧（第 4 行）。
async function buildBaseArtifacts() {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-builder-'));
  let db;
  try {
    const path = join(directory, 'field.sqlite');
    db = new DatabaseSync(path);
    db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE inspections(id INTEGER PRIMARY KEY, location TEXT, note TEXT);');
    db.exec("INSERT INTO inspections VALUES(1,'A区','已巡检');");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const main = Buffer.from(await readFile(path));

    db.exec("INSERT INTO inspections VALUES(2,'B区','需要复查');"); // 提交 1
    const walAfterFirst = Buffer.from(await readFile(path + '-wal'));
    db.exec("INSERT INTO inspections VALUES(3,'C区','已闭环');");   // 提交 2
    const walCommitted = Buffer.from(await readFile(path + '-wal'));

    // 未提交尾帧：取最后一页内容，构造 dbSize=0 的帧，校验和合法但不是提交点。
    const lastPage = walCommitted.subarray(walCommitted.length - PAGE_SIZE);
    const currentPages = main.length / PAGE_SIZE;
    const walWithTail = appendFrame(walCommitted, currentPages, lastPage, 0, { commit: false });

    db.close();
    db = null;
    return { directory, pageSize: PAGE_SIZE, main, walAfterFirst, walCommitted, walWithTail };
  } catch (error) {
    db?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function manifestFor(batch, main, wal, extra = {}) {
  const salt = [wal.readUInt32BE(16), wal.readUInt32BE(20)];
  return buildManifest({
    batch, pageSize: PAGE_SIZE, walSalt: salt,
    files: [{ name: MAIN_NAME, bytes: main }, { name: WAL_NAME, bytes: wal }],
    ...extra,
  });
}

function delivery(batch, main, wal) {
  const manifest = manifestFor(batch, main, wal);
  return new Map([
    [MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2))],
    [MAIN_NAME, main],
    [WAL_NAME, wal],
  ]);
}

// 全套演练场景。每个场景返回三份交付字节与预期说明。
export async function buildScenarios() {
  const base = await buildBaseArtifacts();
  const scenarios = {};

  // 1. 正常交付：两个完整提交 + 一个未提交尾帧；接收只采到最后一个提交（3 行），尾帧不落地。
  scenarios.valid = {
    label: '正常交付（含未提交尾帧）',
    delivery: delivery('field-001', base.main, base.walWithTail),
    expect: { accepted: true, rows: 3, appliedFrames: 2, uncommittedFrames: 1 },
    cleanup: () => rm(base.directory, { recursive: true, force: true }),
  };

  // 2. 提交尾部截断：描述文件与字节自洽，但 WAL 在最后一个提交帧中途被截断。
  //    前一个提交完整，因此仍可接收，但只采到截断前的最后完整提交（2 行）。
  const truncated = Buffer.concat([
    base.walAfterFirst,
    base.walCommitted.subarray(WAL_HEADER_SIZE + 1 * FRAME_SIZE, WAL_HEADER_SIZE + 1 * FRAME_SIZE + 200),
  ]);
  scenarios.truncated = {
    label: '提交尾部截断（保留前一个完整提交）',
    delivery: delivery('field-002', base.main, truncated),
    expect: { accepted: true, rows: 2, appliedFrames: 1, trailingBytes: 200 },
    cleanup: () => {},
  };

  // 3. 头部盐值损坏：直接翻转 WAL 头盐且不重算，头校验和立即失败。
  const brokenSalt = Buffer.from(base.walWithTail);
  brokenSalt[16] ^= 0xff;
  scenarios['broken-salt'] = {
    label: 'WAL 头盐损坏（头校验和失败）',
    delivery: delivery('field-003', base.main, brokenSalt),
    expect: { accepted: false, reason: /WAL 头校验和/ },
    cleanup: () => {},
  };

  // 4. 外来 WAL：来自另一份独立主库，盐值与本批次描述文件声明不一致。
  // 外来库建在基础目录内，随 cleanupAll 统一回收，避免临时目录泄漏。
  const foreignDirectory = join(base.directory, 'foreign');
  await mkdir(foreignDirectory, { recursive: false });
  let foreignDb;
  try {
    const foreignPath = join(foreignDirectory, 'other.sqlite');
    foreignDb = new DatabaseSync(foreignPath);
    foreignDb.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    foreignDb.exec('CREATE TABLE inspections(id INTEGER PRIMARY KEY, location TEXT, note TEXT);');
    foreignDb.exec("INSERT INTO inspections VALUES(1,'外部批次','无关数据');");
    foreignDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    foreignDb.exec("INSERT INTO inspections VALUES(2,'外部批次','另一库的提交');");
    const foreignWal = Buffer.from(await readFile(foreignPath + '-wal'));
    foreignDb.close();
    foreignDb = null;
    // 描述文件按本批次主库与外来 WAL 的实际盐值声明，盐值核对必然冲突。
    const foreignManifest = buildManifest({
      batch: 'field-004', pageSize: PAGE_SIZE, walSalt: [base.walWithTail.readUInt32BE(16), base.walWithTail.readUInt32BE(20)],
      files: [{ name: MAIN_NAME, bytes: base.main }, { name: WAL_NAME, bytes: foreignWal }],
    });
    scenarios['foreign-wal'] = {
      label: 'WAL 来自其他主库（盐值与描述声明冲突）',
      delivery: new Map([
        [MANIFEST_NAME, Buffer.from(JSON.stringify(foreignManifest, null, 2))],
        [MAIN_NAME, base.main],
        [WAL_NAME, foreignWal],
      ]),
      expect: { accepted: false, reason: /盐值/ },
      cleanup: () => {},
    };
  } catch (error) {
    foreignDb?.close();
    throw error;
  }

  // 5. 伪造自洽外来 WAL：盐值被重算为描述文件期望值，格式校验全过，但业务内容来自别的库。
  const forged = rebaseSalt(Buffer.from(scenarios['foreign-wal'].delivery.get(WAL_NAME)),
    [base.walWithTail.readUInt32BE(16), base.walWithTail.readUInt32BE(20)]);
  scenarios['forged-wal'] = {
    label: '伪造盐值自洽的外来 WAL（完整性/业务校验防线）',
    delivery: delivery('field-005', base.main, forged),
    expect: { accepted: true, rows: 2, note: '格式自洽时由完整性与业务表校验兜底，摘要绑定是首要防线' },
    cleanup: () => {},
  };

  // 6. 摘要不符：主库被翻转一字节，但描述文件仍保留原始摘要，摘要核对阶段拒绝。
  const originalManifest = manifestFor('field-006', base.main, base.walWithTail);
  const tampered = Buffer.from(base.main);
  tampered[100] ^= 0x01;
  scenarios['tampered-main'] = {
    label: '主库字节与描述摘要不符',
    delivery: new Map([
      [MANIFEST_NAME, Buffer.from(JSON.stringify(originalManifest, null, 2))],
      [MAIN_NAME, tampered],
      [WAL_NAME, base.walWithTail],
    ]),
    expect: { accepted: false, reason: /摘要不符/ },
    cleanup: () => {},
  };

  return { scenarios, base, cleanupAll: async () => { await rm(base.directory, { recursive: true, force: true }); } };
}

// 把三份交付字节写入一个全新的空目录（每个场景独立目录，符合不可信数据隔离要求）。
export async function materialize(directory, deliveryMap) {
  await mkdir(directory, { recursive: false });
  for (const [name, bytes] of deliveryMap) {
    await writeFile(join(directory, name), bytes, { flag: 'wx' });
  }
  return directory;
}

export { sha256, MANIFEST_NAME, MAIN_NAME, WAL_NAME };
