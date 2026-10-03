# IPv4 CIDR 集合归并与差集解释后端

离线 IPv4 地址集合计算服务：把零散地址和网段整理成精确覆盖、互不重叠、不可再合并的 CIDR 清单。
只做集合计算——不分配地址、不管理租约、不探测网络、不解释防火墙规则优先级。

技术栈：TypeScript + Node.js（内置 `node:http` 与 `node:sqlite`，零运行时依赖）+ SQLite。
Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 功能

- 输入：单个点分十进制地址（视为 /32）和 `a.b.c.d/p` 形式的 CIDR
- 命名集合 + 版本管理：每次导入生成新版本，旧版本与旧报告永久保留
- 计算：集合归并（merge）、两集合交集（intersect）、差集（subtract）、单地址归属查询
- 输出：按起始地址排序、互不重叠、不可继续合并的最小 CIDR 清单 + 地址总数 + 拆分说明
- 归属查询返回 `kept`（保留）/ `excluded`（曾出现但被排除）/ `never`（从未出现）
- SQLite 保存原始输入、版本、操作参数和完整结果；修改源集合不影响旧报告
- API 与 CLI 双入口，支持导入、计算、查看清单、成员查询和 JSON 导出

## 核心设计

- 自行实现地址数值转换、区间运算与最小 CIDR 分解，不调用现成网段求解器
- IPv4 视为完整无符号 32 位空间（0 到 4294967295），网络地址与广播地址都是普通集合元素
- 全部使用 number 算术（2^32 在 IEEE 754 double 内精确），不使用 JavaScript 位运算，避免有符号 32 位结果干扰
- 地址总数最大可达 4294967296（`0.0.0.0/0`），JSON 序列化保持精确
- 带主机位的 CIDR（如 `10.0.0.1/24`）按掩码规范化为 `10.0.0.0/24` 并在 `notes` 中提示
- 非法四段格式、前导零、前缀越界（/33）、空元素均返回明确错误，不静默修正
- 差集不会扩大原集合；相邻但不对齐的块（如 `10.0.0.1` 与 `10.0.0.2`）不会被强行拼成更大网段
- 重复与嵌套输入不重复计数；输入顺序不影响结果；归并幂等

## 快速开始

要求：Node.js >= 22.5（使用了内置 `node:sqlite`，开发使用 Node 25 验证）。

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认端口 0 = 自动选择空闲端口，启动时打印实际端口）
npm run demo       # 运行演示：相邻 /25 合成 /24 → 排除单地址 → 求交
```

## CLI 用法

```powershell
node dist/src/cli.js <命令> [参数]
```

| 命令 | 说明 |
| --- | --- |
| `serve [--port N]` | 启动 HTTP API；默认端口 0（自动选空闲端口），也可用环境变量 `PORT` |
| `import <名称> <元素...\|@文件>` | 导入集合新版本；`@文件` 按行读取元素，`#` 开头为注释 |
| `merge <名称[@版本]>` | 归并集合并生成报告 |
| `intersect <A[@v]> <B[@v]>` | 两集合求交 |
| `subtract <A[@v]> <B[@v]>` | 差集 A − B |
| `member <名称[@v]\|report:<id>> <地址>` | 归属查询（kept/excluded/never） |
| `list` / `show <名称[@版本]>` | 列出集合 / 查看版本详情 |
| `reports` / `report <id>` | 列出报告 / 查看报告 |
| `export <reportId> <文件>` | 导出报告 JSON |

环境变量：`CIDR_DATA_DIR`（数据目录，默认 `./data`，数据库文件为 `cidr.db`）。

示例：

```powershell
node dist/src/cli.js import office 10.0.0.0/25 10.0.0.128/25
node dist/src/cli.js import block 10.0.0.5
node dist/src/cli.js subtract office block
node dist/src/cli.js member report:1 10.0.0.5
node dist/src/cli.js export 1 report.json
```

## HTTP API

所有响应均为 JSON；错误统一为 `{"error":{"code","message"}}`，HTTP 状态 400（参数/业务错误）/ 404 / 500。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/sets` | 创建集合版本，body: `{"name","items":[...]}` |
| GET | `/sets` | 列出所有集合 |
| GET | `/sets/:name` | 列出某集合的版本 |
| POST | `/sets/:name/versions` | 追加新版本，body: `{"items":[...]}` |
| GET | `/sets/:name/versions/:v` | 读取指定版本（含原始输入与规范化结果） |
| POST | `/compute/merge` | body: `{"set","version"?}` |
| POST | `/compute/intersect` | body: `{"a":{"set","version"?},"b":{...}}` |
| POST | `/compute/subtract` | 同上，计算 A − B |
| POST | `/query/membership` | `{"set","version"?,"ip"}` 或 `{"report":id,"ip"}` |
| GET | `/reports` / `/reports/:id` | 列出 / 读取报告（含操作参数与完整结果） |

计算响应包含：`reportId`、`input`（输入集合与版本）、`normalized`（逐元素规范化对照）、
`cidrs`（最小 CIDR 清单）、`total`（地址总数）、`notes`（规范化与拆分说明）。

### 错误码

`INVALID_IP`（非法四段格式/前导零/八位段越界）、`INVALID_PREFIX`（前缀越界或非法）、
`INVALID_CIDR`、`EMPTY_ITEMS`（空元素列表）、`EMPTY_ELEMENT`（空元素）、
`SET_NOT_FOUND`、`VERSION_NOT_FOUND`、`REPORT_NOT_FOUND`、`INVALID_REF`、
`INVALID_ITEMS`、`INVALID_NAME`、`INVALID_QUERY`、`INVALID_PORT`、`BAD_JSON`、`NOT_FOUND`。

## 项目结构

```
src/ipv4.ts     IPv4 数值转换、区间合并/交/差、最小 CIDR 分解（纯算术，无位运算）
src/setops.ts   集合层：归并、交集、差集、归属查询、说明生成
src/store.ts    SQLite 持久化（集合版本 + 不可变报告）
src/service.ts  业务层：版本解析、报告生成
src/api.ts      HTTP API（node:http，默认端口 0 自动选空闲端口）
src/cli.ts      命令行入口
test/           node:test 测试（核心运算 + 持久化 + API 端到端）
scripts/demo.js 演示脚本
```

## 测试覆盖

- `/0`（总数精确 4294967296）、`/32`、首地址 `0.0.0.0`、末地址 `255.255.255.255`
- 相邻 /25 合成 /24、嵌套与重复网段、无交集、全部删除、非对齐相邻范围
- 最后一个八位段内的小例子用直接枚举地址集合核对归并、交集、差集与最小覆盖
- 输入顺序不影响结果；归并幂等；差集不扩大原集合
- 错误输入不留下成功记录；关闭并重新打开数据库后读取同一报告（模拟服务重启）
- HTTP API 端到端（自动空闲端口、错误码、报告查询）

## 已知限制

- 仅支持 IPv4；不支持 IPv6
- 单进程服务，无鉴权，监听 `127.0.0.1`，仅供本机使用
- `node:sqlite` 在 Node 25 仍标记为实验特性（启动脚本已用 `--disable-warning` 静默提示）；如需完全稳定的 API，可替换为 `better-sqlite3`
- 归属查询的 `excluded` 语义基于差集报告的被减集原始输入判定
