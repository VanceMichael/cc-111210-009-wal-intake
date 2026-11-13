import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWal, applyCommitted } from '../src/wal.mjs';

const PAGE_SIZE = 4096;
const FRAME_SIZE = 24 + PAGE_SIZE;

function checksum(littleEndian, buffer, s0 = 0, s1 = 0) {
  for (let offset = 0; offset + 8 <= buffer.length; offset += 8) {
    const w0 = littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const w1 = littleEndian ? buffer.readUInt32LE(offset + 4) : buffer.readUInt32BE(offset + 4);
    s0 = (s0 + w0 + s1) >>> 0;
    s1 = (s1 + w1 + s0) >>> 0;
  }
  return [s0 >>> 0, s1 >>> 0];
}

async function makeCommittedWal(frameCount) {
  const directory = await mkdtemp(join(tmpdir(), 'wal-test-'));
  let db;
  try {
    const path = join(directory, 'f.sqlite');
    db = new DatabaseSync(path);
    db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE inspections(id INTEGER PRIMARY KEY, location TEXT, note TEXT);');
    db.exec("INSERT INTO inspections VALUES(1,'A','x'); PRAGMA wal_checkpoint(TRUNCATE);");
    const main = await readFile(path);
    for (let i = 0; i < frameCount; i++) {
      db.exec(`INSERT INTO inspections VALUES(${i + 2},'L${i}','n${i}');`);
    }
    const wal = await readFile(path + '-wal');
    db.close();
    return { directory, main, wal };
  } catch (error) {
    db?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('真实 WAL 头、盐值与链式帧校验和全部通过', async () => {
  const { directory, main, wal } = await makeCommittedWal(2);
  try {
    const parsed = parseWal(wal);
    assert.equal(parsed.pageSize, PAGE_SIZE);
    assert.equal(parsed.frameCount, 2);
    assert.equal(parsed.lastCommit, 1);
    assert.equal(parsed.trailingBytes, 0);
    assert.deepEqual(parsed.salt, [wal.readUInt32BE(16), wal.readUInt32BE(20)]);
    const { bytes, appliedFrames, committedPages } = applyCommitted(main, wal, parsed);
    assert.equal(appliedFrames, 2);
    assert.equal(bytes.length, committedPages * PAGE_SIZE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('未提交尾帧被识别但不采，只应用到最后一个完整提交', async () => {
  const { directory, main, wal } = await makeCommittedWal(2);
  try {
    const littleEndian = wal.readUInt32BE(0) === 0x377f0682;
    const salt = [wal.readUInt32BE(16), wal.readUInt32BE(20)];
    const lastPage = wal.subarray(wal.length - PAGE_SIZE);
    const tail = Buffer.alloc(FRAME_SIZE);
    tail.writeUInt32BE(main.length / PAGE_SIZE, 0);
    tail.writeUInt32BE(0, 4); // dbSize=0：非提交帧
    tail.writeUInt32BE(salt[0], 8);
    tail.writeUInt32BE(salt[1], 12);
    let s = checksum(littleEndian, wal.subarray(0, 24));
    for (let i = 0; i < 2; i++) {
      const off = 32 + i * FRAME_SIZE;
      s = checksum(littleEndian, wal.subarray(off, off + 8), s[0], s[1]);
      s = checksum(littleEndian, wal.subarray(off + 24, off + 24 + PAGE_SIZE), s[0], s[1]);
    }
    s = checksum(littleEndian, tail.subarray(0, 8), s[0], s[1]);
    lastPage.copy(tail, 24);
    s = checksum(littleEndian, tail.subarray(24, 24 + PAGE_SIZE), s[0], s[1]);
    tail.writeUInt32BE(s[0], 16);
    tail.writeUInt32BE(s[1], 20);
    const withTail = Buffer.concat([wal, tail]);

    const parsed = parseWal(withTail);
    assert.equal(parsed.frameCount, 3);
    assert.equal(parsed.lastCommit, 1);
    assert.equal(parsed.frames[2].isCommit, false);
    const { appliedFrames } = applyCommitted(main, withTail, parsed);
    assert.equal(appliedFrames, 2); // 尾帧不落地
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('截断的尾字节计入 trailingBytes，不破坏前面的完整提交', async () => {
  const { directory, main, wal } = await makeCommittedWal(2);
  try {
    const truncated = wal.subarray(0, wal.length - 300);
    const parsed = parseWal(truncated);
    assert.equal(parsed.frameCount, 1);
    assert.equal(parsed.lastCommit, 0);
    assert.equal(parsed.trailingBytes, FRAME_SIZE - 300);
    const { bytes } = applyCommitted(main, truncated, parsed);
    assert.ok(bytes.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('损坏的 WAL 头魔数与头校验和被拒绝', () => {
  const wal = Buffer.alloc(64);
  assert.throws(() => parseWal(wal), /魔数/);
});

test('校验和字节序由 WAL 头自证，不依赖对 magic 的硬编码假设', async () => {
  const { directory, wal } = await makeCommittedWal(1);
  try {
    const parsed = parseWal(wal);
    // 演练构建的校验和按小端解释；魔数仍被校验为两种合法值之一。
    assert.ok([0x377f0682, 0x377f0683].includes(parsed.magic));
    assert.equal(parsed.littleEndian, true);
    // 破坏头部参与校验和的字节后，两种字节序都无法匹配。
    const corrupted = Buffer.from(wal);
    corrupted[20] ^= 0x01; // 盐值第二字，参与头校验和
    assert.throws(() => parseWal(corrupted), /头校验和失败/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('翻转帧页数据导致帧校验和失败', async () => {
  const { directory, wal } = await makeCommittedWal(1);
  try {
    const corrupted = Buffer.from(wal);
    corrupted[32 + 24 + 100] ^= 0xff; // 破坏第一帧页数据
    assert.throws(() => parseWal(corrupted), /帧 0 校验和失败/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('帧盐值与头盐不一致被拒绝', async () => {
  const { directory, wal } = await makeCommittedWal(1);
  try {
    const corrupted = Buffer.from(wal);
    corrupted[32 + 8] ^= 0xff; // 破坏帧盐
    assert.throws(() => parseWal(corrupted), /盐值/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expectedSalt 与 WAL 头盐不一致时拒绝外来 WAL', async () => {
  const { directory, wal } = await makeCommittedWal(1);
  try {
    assert.throws(() => parseWal(wal, { expectedSalt: [1, 2] }), /盐值与交付描述不一致/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('没有任何提交帧时拒绝生成接收版本', async () => {
  const { directory, main, wal } = await makeCommittedWal(1);
  try {
    // 把唯一一帧的 dbSize 清零，重算帧校验和，得到无提交的 WAL。
    const littleEndian = wal.readUInt32BE(0) === 0x377f0682;
    const noCommit = Buffer.from(wal);
    noCommit.writeUInt32BE(0, 32 + 4);
    let s = checksum(littleEndian, noCommit.subarray(0, 24));
    s = checksum(littleEndian, noCommit.subarray(32, 32 + 8), s[0], s[1]);
    s = checksum(littleEndian, noCommit.subarray(32 + 24, 32 + 24 + PAGE_SIZE), s[0], s[1]);
    noCommit.writeUInt32BE(s[0], 32 + 16);
    noCommit.writeUInt32BE(s[1], 32 + 20);
    const parsed = parseWal(noCommit);
    assert.equal(parsed.lastCommit, -1);
    assert.throws(() => applyCommitted(main, noCommit, parsed), /不存在任何完整提交/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
