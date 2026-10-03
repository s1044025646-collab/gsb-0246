import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { Service } from "./service";
import { startServer } from "./api";
import { CidrError } from "./ipv4";

const DATA_DIR = process.env.CIDR_DATA_DIR ?? path.join(process.cwd(), "data");

function print(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

function fail(err: unknown): never {
  if (err instanceof CidrError) {
    process.stderr.write(`错误 [${err.code}] ${err.message}\n`);
  } else {
    process.stderr.write(`错误 ${String(err)}\n`);
  }
  process.exit(1);
}

function parseSetRef(text: string): { set: string; version?: number } {
  const m = text.match(/^([^@]+)(?:@(\d+))?$/);
  if (!m) throw new CidrError("INVALID_REF", `非法集合引用: "${text}"，格式为 名称 或 名称@版本`);
  return { set: m[1], version: m[2] ? Number(m[2]) : undefined };
}

function readItems(args: string[]): string[] {
  // 支持 @文件路径 导入（每行一个元素，# 开头为注释），其余参数视为字面元素
  const items: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("@")) {
      const file = arg.slice(1);
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith("#")) items.push(t);
      }
    } else {
      items.push(arg);
    }
  }
  return items;
}

const USAGE = `用法: node dist/cli.js <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API（默认端口 0，即自动选择空闲端口）
  import <名称> <元素...|@文件>    导入/新增集合版本
  merge <名称[@版本]>              归并集合并生成报告
  intersect <A[@v]> <B[@v]>        两集合求交
  subtract <A[@v]> <B[@v]>         差集 A - B
  member <名称[@v]|report:<id>> <地址>  归属查询（kept/excluded/never）
  list                             列出所有集合
  show <名称[@版本]>               查看集合版本详情
  reports                          列出所有报告
  report <id>                      查看报告
  export <reportId> <文件>         导出报告 JSON

环境变量: CIDR_DATA_DIR（数据目录，默认 ./data），PORT（serve 默认端口）
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const store = new Store(DATA_DIR);
  const service = new Service(store);
  try {
    switch (cmd) {
      case "serve": {
        const idx = args.indexOf("--port");
        const port = idx >= 0 ? Number(args[idx + 1]) : Number(process.env.PORT ?? 0);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new CidrError("INVALID_PORT", "端口必须是 0-65535 的整数（0 表示自动选择空闲端口）");
        }
        const actual = await startServer(service, port);
        process.stdout.write(`API 已启动: http://127.0.0.1:${actual} （数据目录: ${path.resolve(DATA_DIR)}）\n`);
        return; // 保持进程运行
      }
      case "import": {
        const [name, ...rest] = args;
        if (!name) throw new CidrError("INVALID_ARGS", "import 需要集合名称和元素");
        print(service.importSet(name, readItems(rest)));
        break;
      }
      case "merge": {
        if (!args[0]) throw new CidrError("INVALID_ARGS", "merge 需要集合引用");
        print(service.merge(parseSetRef(args[0])));
        break;
      }
      case "intersect": {
        if (args.length < 2) throw new CidrError("INVALID_ARGS", "intersect 需要两个集合引用");
        print(service.intersect(parseSetRef(args[0]), parseSetRef(args[1])));
        break;
      }
      case "subtract": {
        if (args.length < 2) throw new CidrError("INVALID_ARGS", "subtract 需要两个集合引用");
        print(service.subtract(parseSetRef(args[0]), parseSetRef(args[1])));
        break;
      }
      case "member": {
        if (args.length < 2) throw new CidrError("INVALID_ARGS", "member 需要集合引用（或 report:<id>）和地址");
        if (args[0].startsWith("report:")) {
          print(service.membershipByReport(args[1], Number(args[0].slice(7))));
        } else {
          print(service.membership(args[1], parseSetRef(args[0])));
        }
        break;
      }
      case "list":
        print({ sets: store.listSets() });
        break;
      case "show": {
        if (!args[0]) throw new CidrError("INVALID_ARGS", "show 需要集合引用");
        const ref = parseSetRef(args[0]);
        print(store.getVersion(ref.set, ref.version));
        break;
      }
      case "reports":
        print({ reports: store.listReports() });
        break;
      case "report": {
        if (!args[0]) throw new CidrError("INVALID_ARGS", "report 需要报告 id");
        print(store.getReport(Number(args[0])));
        break;
      }
      case "export": {
        if (args.length < 2) throw new CidrError("INVALID_ARGS", "export 需要报告 id 和输出文件");
        const report = store.getReport(Number(args[0]));
        fs.writeFileSync(args[1], JSON.stringify(report, null, 2) + "\n", "utf8");
        process.stdout.write(`已导出报告 ${args[0]} 到 ${args[1]}\n`);
        break;
      }
      default:
        process.stderr.write(`未知命令: ${cmd}\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch(fail);
