# 移动巡检离线数据库的安全接收

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm run demo:offline
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm run demo:offline` 演示只读来源的离线接收：正常交付（未提交尾帧不落地）、提交尾部截断、WAL 来自其他主库、重复接收、同批次内容冲突隔离、切换前进程退出，并核对原始交付字节不变、接收目录无数据库运行产物。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 离线接收（三份交付文件）

现场回港的一份交付固定为 `manifest.json`（描述文件）、`main.sqlite`（主库）、`main.sqlite-wal`（WAL）。接收侧先核对描述文件与全部文件摘要，再校验 WAL 头、盐值、链式帧校验和与提交边界，只采到最后一个完整提交，未提交或截断尾帧不落地；随后在独立工作副本上生成可查询的接收版本，经 SQLite 完整性检查与业务表校验后原子发布。接收目录不是数据库运行目录，也从不对交来的主库执行恢复写入。协议细节见 `docs/source-contract.md`。

命令行从独立交付目录接收（交付目录只读，数据写入接收目录）：

```sh
node src/intake-cli.mjs --delivery /path/to/delivery --data /path/to/data-dir
# 演练“切换前进程退出”：INTAKE_CRASH_BEFORE_SWITCH=1
```

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

离线接收接口：`GET /offline/intake`（从来源抓取三份交付并执行完整流水线，失败返回 422 并留证）、`GET /offline/current`（当前发布指针与回执）、`GET /offline/rows`（查询当前发布版本的巡检行）、`GET /offline/evidence`（失败与冲突证据清单）。

`src/connector.mjs` 解释单次来源响应，`src/manifest.mjs` 处理描述文件与摘要核对，`src/wal.mjs` 只读解析 WAL 并在工作副本上应用已提交帧，`src/intake.mjs` 编排离线接收与原子发布，`src/intake-cli.mjs` 提供命令行入口，`fixtures/source.mjs` 提供可重复启动的本地来源，`fixtures/delivery.mjs` 构造多提交/截断/外来 WAL 等离线交付场景，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。测试见 `test/wal.test.mjs`、`test/manifest.test.mjs`、`test/intake.test.mjs`、`test/offline-service.test.mjs` 及原有的连接器与服务测试。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
