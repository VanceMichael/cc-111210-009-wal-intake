// SQLite WAL（Write-Ahead Log）只读解析与工作副本应用。
// 依据 SQLite 文件格式实现：WAL 头 32 字节、帧头 24 字节、盐值、链式校验和、提交边界。
// 本模块绝不打开来源主库、绝不对来源文件执行任何写入，所有产物都落在独立工作副本上。

export const WAL_HEADER_SIZE = 32;
export const FRAME_HEADER_SIZE = 24;
const WAL_MAGIC_BE = 0x377f0682;
const WAL_MAGIC_LE = 0x377f0683;

// SQLite 校验和：按 32 位字做两轮带进位累加。
// 实测演练构建（magic 377f0682）以小端解释参与校验和的字；两种 magic 都支持，按文件自证选择。
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

// 解析并完整校验一份 WAL 字节，返回帧序列与最后一个完整提交的位置。
// 严格规则：
//  - 魔数、页大小、长度结构必须合法；
//  - WAL 头校验和（前 24 字节）必须与头部自记值一致；
//  - 每一帧的盐值必须等于 WAL 头盐值；
//  - 帧校验和是链式累计值，覆盖帧头前 8 字节（页号/库大小）与整页数据，
//    盐值字段与校验和字段本身不参与计算；
//  - dbSize 非零的帧为提交帧；只承认最后一个提交帧及其之前的帧为已落地；
//  - 提交帧之后的未提交帧、不足一帧的截断尾字节一律不采。
export function parseWal(wal, { expectedSalt } = {}) {
  if (!Buffer.isBuffer(wal) || wal.length < WAL_HEADER_SIZE) {
    throw new Error('WAL 长度不足 32 字节，无法读取 WAL 头');
  }
  const magic = wal.readUInt32BE(0);
  if (magic !== WAL_MAGIC_BE && magic !== WAL_MAGIC_LE) {
    throw new Error(`WAL 魔数无效：0x${magic.toString(16)}`);
  }

  const formatVersion = wal.readUInt32BE(4);
  if (formatVersion !== 3007000) throw new Error(`WAL 格式版本不受支持：${formatVersion}`);
  const pageSize = wal.readUInt32BE(8);
  if (!Number.isInteger(pageSize) || pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || pageSize > 65536) {
    throw new Error(`WAL 声明的页大小非法：${pageSize}`);
  }
  const checkpointSeq = wal.readUInt32BE(12);
  const salt = [wal.readUInt32BE(16), wal.readUInt32BE(20)];
  if (expectedSalt && (expectedSalt[0] !== salt[0] || expectedSalt[1] !== salt[1])) {
    throw new Error(`WAL 盐值与交付描述不一致：头盐 ${salt.join(':')}，期望 ${expectedSalt.join(':')}`);
  }

  // 字节序自证：分别按小端/大端复算 WAL 头前 24 字节，与头部自记校验和比对，
  // 匹配者即为该文件的校验和字节序，不依赖对 magic 数值的硬编码假设。
  const storedHeaderSum = [wal.readUInt32BE(24), wal.readUInt32BE(28)];
  let littleEndian;
  let headerSum;
  for (const candidate of [true, false]) {
    const result = makeChecksum(candidate)(wal.subarray(0, 24));
    if (result[0] === storedHeaderSum[0] && result[1] === storedHeaderSum[1]) {
      littleEndian = candidate;
      headerSum = result;
      break;
    }
  }
  if (littleEndian === undefined) {
    throw new Error('WAL 头校验和失败，文件已损坏或被改写');
  }
  const checksum = makeChecksum(littleEndian);
  const [headerSum0, headerSum1] = headerSum;

  const frameSize = FRAME_HEADER_SIZE + pageSize;
  const frameCount = Math.floor((wal.length - WAL_HEADER_SIZE) / frameSize);
  const frames = [];
  let running = [headerSum0, headerSum1];
  let lastCommit = -1;

  for (let index = 0; index < frameCount; index++) {
    const offset = WAL_HEADER_SIZE + index * frameSize;
    const pageNumber = wal.readUInt32BE(offset);
    const databaseSize = wal.readUInt32BE(offset + 4);
    const frameSalt = [wal.readUInt32BE(offset + 8), wal.readUInt32BE(offset + 12)];
    if (frameSalt[0] !== salt[0] || frameSalt[1] !== salt[1]) {
      throw new Error(`帧 ${index} 盐值与 WAL 头盐值不一致`);
    }
    if (!Number.isInteger(pageNumber) || pageNumber === 0) {
      throw new Error(`帧 ${index} 页号非法`);
    }
    running = checksum(wal.subarray(offset, offset + 8), running[0], running[1]);
    running = checksum(wal.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + pageSize), running[0], running[1]);
    const storedSum = [wal.readUInt32BE(offset + 16), wal.readUInt32BE(offset + 20)];
    if (running[0] !== storedSum[0] || running[1] !== storedSum[1]) {
      throw new Error(`帧 ${index} 校验和失败，链路在该帧处已损坏`);
    }
    const isCommit = databaseSize !== 0;
    if (isCommit) {
      if (!Number.isInteger(databaseSize) || databaseSize === 0) throw new Error(`帧 ${index} 提交库大小非法`);
      lastCommit = index;
    }
    frames.push({ index, pageNumber, databaseSize, isCommit });
  }

  const trailingBytes = wal.length - WAL_HEADER_SIZE - frameCount * frameSize;
  return {
    magic,
    littleEndian,
    pageSize,
    checkpointSeq,
    salt,
    frames,
    frameCount,
    lastCommit,
    trailingBytes,
  };
}

// 把截至最后一个完整提交的所有帧按序应用到主库工作副本，返回可独立打开的接收版本字节。
// 不修改入参 main/wal。提交帧之后的未提交帧与截断尾字节不会被应用。
export function applyCommitted(main, wal, parsed = parseWal(wal)) {
  if (parsed.lastCommit < 0) {
    throw new Error('WAL 中不存在任何完整提交帧，拒绝生成接收版本');
  }
  const { pageSize, frames, lastCommit } = parsed;
  const committed = frames.slice(0, lastCommit + 1);
  const commitFrame = committed[committed.length - 1];
  const committedPages = commitFrame.databaseSize;

  let capacity = main.length;
  for (const frame of committed) capacity = Math.max(capacity, frame.pageNumber * pageSize);
  capacity = Math.max(capacity, committedPages * pageSize);
  const output = Buffer.alloc(capacity);
  main.copy(output);

  for (const frame of committed) {
    const frameOffset = WAL_HEADER_SIZE + frame.index * (FRAME_HEADER_SIZE + pageSize);
    wal.copy(output, (frame.pageNumber - 1) * pageSize, frameOffset + FRAME_HEADER_SIZE, frameOffset + FRAME_HEADER_SIZE + pageSize);
  }

  // 与 SQLite 恢复逻辑保持一致：提交库大小写入主库头 28 偏移，
  // 并把 92 偏移的“大小有效版本”写成当前文件变更计数器（24 偏移）。
  output.writeUInt32BE(committedPages, 28);
  output.writeUInt32BE(output.readUInt32BE(24), 92);
  return { bytes: output.subarray(0, committedPages * pageSize), committedPages, appliedFrames: committed.length };
}
