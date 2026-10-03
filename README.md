# IPv4 CIDR 集合归并与差集解释后端

离线运行的 IPv4 地址集合计算服务。把零散的单地址与 CIDR 网段整理成**按起始地址排列、互不重叠、无法继续合并的最小 CIDR 清单**，并支持命名集合版本、交集、差集、单地址归属查询与 JSON 导出。

只做集合计算：**不**分配地址、**不**管理租约、**不**探测网络、**不**解释防火墙规则优先级。

## 运行环境

- Windows 本地直接运行，无需 Docker、WSL、付费服务或外部在线 API。
- Node.js >= 22（开发与验证使用 Node v25，内置 `node:sqlite`，无需本地编译原生模块）。
- 仅开发依赖 `typescript` 与 `@types/node`。

## 快速开始

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建 + 编译测试 + 运行 18 个用例
npm run demo       # 端到端演示（使用临时数据目录，不影响本地数据）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
```

自定义端口与数据目录：

```powershell
$env:PORT="8080"; $env:DATA_DIR="$PWD\data"; npm start
# 或
node --no-warnings dist/server.js 8080
```

启动后控制台打印实际监听地址，例如 `http://127.0.0.1:51223`。数据文件默认在项目内 `data/cidr.sqlite`。

## 计算语义

- IPv4 被视为完整的无符号 32 位空间 `0.0.0.0` – `255.255.255.255`；网络地址与广播地址都作为普通元素计数。
- 内部全部使用 `BigInt` 运算，不受 JavaScript 位运算有符号 32 位结果影响；地址总数以**字符串**精确序列化，最大 `4294967296`（`/0`）。
- 裸地址按 `/32` 处理；`192.168.1.10/24` 这类带主机位的输入会**规范化为网络地址**并在 `notes` 中给出提示，绝不静默改成另一个地址。
- 非法四段格式、段越界（>255）、前缀越界（不在 0–32）、空元素立即返回明确错误码；导入失败时事务回滚，不留下任何成功记录。
- 重复输入只计数一次；输出先合并重叠/相邻区间，再做**最小对齐 CIDR 分解**。相邻但不对齐的块保持拆分，例如 `10.0.0.1`–`10.0.0.4` 分解为 `10.0.0.1/32`、`10.0.0.2/31`、`10.0.0.4/32`。
- 差集 `A − B` 一定是 A 的子集，不可能扩大原集合。

## CLI

```powershell
# 仅归并不保存
node --no-warnings dist/cli.js normalize --inputs "192.168.1.0/25,192.168.1.128/25"

# 从文件导入（每行一个条目，# 开头为注释）
node --no-warnings dist/cli.js import --name office --file list.txt

node --no-warnings dist/cli.js list                 # 列出所有集合
node --no-warnings dist/cli.js list office          # 列出某集合所有版本
node --no-warnings dist/cli.js show office --version 1
node --no-warnings dist/cli.js intersect --left a --right b
node --no-warnings dist/cli.js diff --left a --right b --left-version 1 --right-version 2
node --no-warnings dist/cli.js member office --address 10.0.0.5
node --no-warnings dist/cli.js report 3             # 查看持久化报告（完整快照）
node --no-warnings dist/cli.js export office --out office.json

# 任意命令加 --json 输出机器可读结果
node --no-warnings dist/cli.js show office --json
```

成员查询状态：

- `member`：在当前版本集合中，并给出命中网段。
- `excluded`：曾在旧版本出现，但当前版本已排除。
- `never_seen`：任何版本都未出现。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/sets/import` | 保存集合新版本，body：`{"name":"office","inputs":[...]}` |
| GET | `/sets` | 列出集合及最新版本 |
| GET | `/sets/:name?version=N` | 查看某版本（默认最新）规范化结果 |
| POST | `/compute/intersection` | 交集，body：`{"leftSet":"a","rightSet":"b"}`，可带 `leftVersion/rightVersion` |
| POST | `/compute/difference` | 差集（左减右） |
| GET | `/sets/:name/membership?address=1.2.3.4` | 单地址归属 |
| GET | `/reports` | 报告列表 |
| GET | `/reports/:id` | 读取报告完整快照 |

计算响应包含所引用的集合版本、规范化网段（含起止地址与块大小）、地址总数字符串与中文说明。错误响应统一为 `{"error":{"code":"...","message":"..."}}`。

```powershell
Invoke-RestMethod http://127.0.0.1:8080/sets/import -Method Post -ContentType "application/json" `
  -Body '{"name":"full","inputs":["192.168.1.0/24"]}'
```

## 版本与报告

- 每次 `import` 产生一个不可变新版本；交集/差集生成独立报告，保存操作参数与**完整结果快照**。
- 后续修改源集合不会改变历史报告内容（已由测试验证）。
- 服务重启后重新打开同一 SQLite 文件，旧版本与报告均可读取。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_FORMAT` | 非四段点分十进制或含非数字段 |
| `OCTET_OUT_OF_RANGE` | 某一段不在 0–255 |
| `INVALID_PREFIX` | 前缀不是整数（如 `/ab`、`/-1`） |
| `PREFIX_OUT_OF_RANGE` | 前缀不在 0–32 |
| `EMPTY_INPUT` | 输入数组为空或存在空元素 |
| `INVALID_NAME` / `MISSING_SET` / `MISSING_ADDRESS` | 参数缺失或非法 |
| `SET_NOT_FOUND` / `REPORT_NOT_FOUND` | 集合或报告不存在（HTTP 404） |
| `INVALID_JSON` | 请求体不是合法 JSON |

## 手算示例

- `192.168.1.0/25` + `192.168.1.128/25` → 恰好合成 `192.168.1.0/24`，总数 256。
- 从 `192.168.1.0/24` 排除 `192.168.1.5/32` → 8 个最小网段，总数 255（见 `npm run demo`）。
- 最后八位段枚举：`{1,2,3,4} ∩ {3,4,5} = {3,4}`；`{1,2,3,4} − {3,4,5} = {1,2}`。
- 覆盖 `/0`、`/32`、`0.0.0.0`、`255.255.255.255`、嵌套/重复、无交集、全部删除与非对齐相邻范围等边界，均在测试中核对。

## 项目结构

```
src/core/ip.ts         # 地址转换、区间运算、最小 CIDR 分解（BigInt）
src/core/normalize.ts  # 输入归并、交集/差集/成员语义
src/db/store.ts        # SQLite：集合版本、操作参数、完整报告
src/server.ts          # HTTP API
src/cli.ts             # 命令行
test/                  # node:test 用例
scripts/demo.mjs       # 端到端演示
```
