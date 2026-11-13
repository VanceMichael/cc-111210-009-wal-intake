# 巡检离线交付

## 来源导出

演练来源启动时由 SQLite 真正生成主数据库与未 checkpoint 的 WAL。`/manifest` 返回描述文件（批次、页大小、WAL 盐值、文件名、大小、SHA256）；`/main.sqlite`、`/main.sqlite-wal` 返回原始导出字节；`/manifest.json` 返回同内容的描述文件字节。`/clean.sqlite` 是 WAL 写入前的完整单库，当前查看器只打开其临时副本。

`/truncated-wal` 截断尾帧，`/wrong-wal` 改变头部 salt。源库没有稳定的“WAL 批次 ID”字段，主库与 WAL 的业务归属首先依赖导出描述文件的摘要绑定；不得声称仅凭 SQLite 主库头可以证明 WAL 来源。

## 描述文件（manifest.json）

```json
{
  "format": "inspection-delivery/1",
  "batch": "field-001",
  "pageSize": 4096,
  "walSalt": [1346525481, 1444842071],
  "files": [
    { "name": "main.sqlite", "size": 8192, "sha256": "..." },
    { "name": "main.sqlite-wal", "size": 4152, "sha256": "..." }
  ]
}
```

一份现场交付固定为三份字节：`manifest.json`、`main.sqlite`、`main.sqlite-wal`。

## 接收流水线（src/intake.mjs、src/wal.mjs）

1. **描述文件核对**：JSON 结构、批次号、页大小、文件条目合法且恰好声明主库与 WAL。
2. **文件摘要核对**：逐文件比对大小与 SHA256；多余文件、缺失文件、任何字节不一致都在打开数据库前拒绝。
3. **主库头核对**：SQLite 魔数、页大小与描述一致、头部页数与文件长度自洽。
4. **WAL 格式校验**：WAL 头魔数与头校验和；描述文件盐值与 WAL 头盐值一致；每帧盐值等于头盐；链式帧校验和（覆盖帧头前 8 字节与整页数据，不含盐值/校验和字段自身）。
5. **提交边界**：`dbSize` 非零帧为提交帧；只承认最后一个提交帧及其之前的帧。其后的未提交帧、不足一帧的截断尾字节一律不采；没有任何完整提交则拒绝。
6. **独立工作副本**：把已提交帧按页号应用到主库副本（绝不写回来源主库），按提交帧库大小截断并校正头部页数，生成可独立打开的 `received.sqlite`。
7. **完整性与业务校验**：以 `file:...?immutable=1` 只读打开工作副本，执行 `PRAGMA integrity_check`，再校验 `inspections` 表及 `id/location/note` 列并读取业务行。
8. **暂存与原子发布**：全部通过后写入暂存目录，`rename` 原子发布到 `received/<批次>/`，再原子切换 `current.json` 指针。

## 接收目录与证据

```
<DATA_DIR>/
  current.json                 # 当前发布指针（原子切换）
  received/<批次>/
    received.sqlite            # 可查询的接收版本（工作副本产物）
    receipt.json               # 回执：批次、整包指纹、WAL 摘要、业务行数、文件摘要
    source/                    # 三份原始交付字节（原样封存）
  failures/<批次>--<时间>--<pid>/   # 失败证据：原始字节 + failure.json
  conflicts/<批次>--<时间>--<pid>/  # 同批次不同内容的冲突证据
  .stage-* / .work-*           # 暂存/工作目录，进程退出后由下次启动清理
```

接收目录不会成为数据库运行目录：所有数据库访问均为只读 immutable 打开，不产生 `-wal/-shm/-journal`。失败只封存证据，不改变 `current.json`，上一版巡检数据继续可查。

- 同批次同内容重传：返回同一份回执（`duplicated: true`），结果幂等。
- 同批次不同内容：冲突隔离到 `conflicts/`，拒绝覆盖已发布版本。
- 切换前进程退出：暂存未发布、`current.json` 不变；下次 `prepare()` 清扫暂存，该批次可重新接收。
