# 巡检离线交付
演练来源启动时由SQLite真正生成主数据库与未checkpoint的WAL。`/manifest` 返回文件名、大小、SHA256和批次；`/main.sqlite`、`/main.sqlite-wal` 返回原始导出字节。`/clean.sqlite` 是WAL写入前的完整单库，当前查看器只打开其临时副本。
`/truncated-wal` 截断尾帧，`/wrong-wal` 改变头部salt。源库没有稳定的“WAL批次ID”字段，主库与WAL的业务归属首先依赖导出描述文件的摘要；不得声称仅凭SQLite主库头可以证明WAL来源。接收逻辑还需按SQLite文件格式验证salt、校验和和提交点。
