#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CidrError, parseIpv4 } from './core/ip.js';
import { normalizeInputs } from './core/normalize.js';
import { Store } from './db/store.js';

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const DB_PATH = resolve(DATA_DIR, 'cidr.sqlite');

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const name = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function requireFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || value === '') {
    throw new CidrError('MISSING_PARAM', `缺少必填参数 --${name}`);
  }
  return value;
}

function parseEntries(flags: Map<string, string | boolean>): string[] {
  const inputs: string[] = [];
  const inline = flags.get('inputs');
  if (typeof inline === 'string') {
    inputs.push(...inline.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const file = flags.get('file');
  if (typeof file === 'string') {
    const text = readFileSync(resolve(file), 'utf-8');
    inputs.push(
      ...text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('#')),
    );
  }
  return inputs;
}

function renderNormalized(result: ReturnType<typeof normalizeInputs>): string {
  const lines: string[] = [];
  lines.push(`输入条目: ${result.inputCount}（重复 ${result.dedupCount}）`);
  lines.push(`地址总数: ${result.totalAddresses}`);
  lines.push('最小覆盖 CIDR:');
  for (const block of result.blocks) {
    lines.push(`  ${block.cidr.padEnd(20)} ${block.start} - ${block.end}  (${block.size})`);
  }
  lines.push('说明:');
  for (const note of result.notes) lines.push(`  - [${note.type}] ${note.message}`);
  return lines.join('\n');
}

const USAGE = `IPv4 CIDR 集合工具

用法:
  cidrset normalize --inputs "10.0.0.0/25,10.0.0.128/25" [--file list.txt]
  cidrset import   --name office --inputs "10.0.0.1,10.0.0.0/24"
  cidrset list [集合名]
  cidrset show     <集合名> [--version N]
  cidrset intersect --left A --right B [--left-version N] [--right-version M]
  cidrset diff      --left A --right B [...]
  cidrset member    <集合名> --address 10.0.0.5
  cidrset report    <报告ID>
  cidrset export    <集合名> --out result.json [--version N]

通用参数:
  --json      以 JSON 输出（export 除外）
  DATA_DIR    环境变量，自定义数据目录（默认 ./data）

地址总数以字符串精确表示，最大 4294967296（/0）。`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const asJson = args.flags.get('json') === true || args.flags.get('json') === 'true';

  const print = (text: string, data?: unknown): void => {
    if (asJson) {
      process.stdout.write(JSON.stringify(data ?? {}, null, 2) + '\n');
    } else {
      process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    }
  };

  switch (command) {
    case 'normalize': {
      const entries = parseEntries(args.flags);
      const result = normalizeInputs(entries);
      print(renderNormalized(result), result);
      return;
    }
    case 'import': {
      const name = requireFlag(args.flags, 'name');
      const entries = parseEntries(args.flags);
      const result = normalizeInputs(entries);
      const store = new Store(DB_PATH);
      try {
        const saved = store.importSet(name, result);
        print(`已保存集合 "${name}" 版本 ${saved.version}\n${renderNormalized(saved.result)}`, {
          name: saved.setName,
          version: saved.version,
          result: saved.result,
        });
      } finally {
        store.close();
      }
      return;
    }
    case 'list': {
      const store = new Store(DB_PATH);
      try {
        if (args.positionals[0]) {
          const versions = store.listVersions(args.positionals[0]);
          if (asJson) print('', versions);
          else {
            for (const v of versions) {
              print(`版本 ${v.version}  总数 ${v.result.totalAddresses}  网段数 ${v.result.blocks.length}  创建于 ${v.createdAt}`);
            }
          }
        } else {
          const sets = store.listSets();
          if (asJson) print('', sets);
          else {
            print('命名集合:');
            for (const s of sets) {
              print(`  ${s.name.padEnd(20)} v${s.latestVersion}  总数 ${s.totalAddresses}`);
            }
          }
        }
      } finally {
        store.close();
      }
      return;
    }
    case 'show': {
      const name = args.positionals[0] ?? requireFlag(args.flags, 'name');
      const version = args.flags.get('version');
      const store = new Store(DB_PATH);
      try {
        const data = store.getVersion(name, version ? Number(version) : undefined);
        print(`集合 "${name}" 版本 ${data.version}\n原始输入: ${data.rawInputs.join(', ')}\n${renderNormalized(data.result)}`, {
          name: data.setName,
          version: data.version,
          rawInputs: data.rawInputs,
          result: data.result,
        });
      } finally {
        store.close();
      }
      return;
    }
    case 'intersect':
    case 'diff': {
      const left = requireFlag(args.flags, 'left');
      const right = requireFlag(args.flags, 'right');
      const leftVersion = args.flags.get('left-version');
      const rightVersion = args.flags.get('right-version');
      const store = new Store(DB_PATH);
      try {
        const { report, result } = store.compute(
          command === 'intersect' ? 'intersection' : 'difference',
          left,
          right,
          typeof leftVersion === 'string' ? Number(leftVersion) : undefined,
          typeof rightVersion === 'string' ? Number(rightVersion) : undefined,
        );
        const head = `报告 #${report.id}  ${result.operation}  ${result.leftSet}@${result.leftVersion} ${
          command === 'intersect' ? '∩' : '−'
        } ${result.rightSet}@${result.rightVersion}`;
        const body = result.blocks
          .map((b) => `  ${b.cidr.padEnd(20)} ${b.start} - ${b.end}  (${b.size})`)
          .join('\n');
        print(
          `${head}\n地址总数: ${result.totalAddresses}\n${body || '  （空集合）'}\n说明:\n${result.notes
            .map((n) => `  - ${n}`)
            .join('\n')}`,
          { reportId: report.id, result },
        );
      } finally {
        store.close();
      }
      return;
    }
    case 'member': {
      const name = args.positionals[0] ?? requireFlag(args.flags, 'name');
      const address = requireFlag(args.flags, 'address');
      parseIpv4(address);
      const version = args.flags.get('version');
      const store = new Store(DB_PATH);
      try {
        const result = store.membership(
          name,
          address,
          typeof version === 'string' ? Number(version) : undefined,
        );
        print(`${result.address}: ${result.status} - ${result.message}`, result);
      } finally {
        store.close();
      }
      return;
    }
    case 'report': {
      const id = Number(args.positionals[0] ?? requireFlag(args.flags, 'id'));
      const store = new Store(DB_PATH);
      try {
        const report = store.getReport(id);
        print(`报告 #${report.id} [${report.operation}] 创建于 ${report.createdAt}`, report);
      } finally {
        store.close();
      }
      return;
    }
    case 'export': {
      const name = args.positionals[0] ?? requireFlag(args.flags, 'name');
      const out = requireFlag(args.flags, 'out');
      const version = args.flags.get('version');
      const store = new Store(DB_PATH);
      try {
        const data = store.getVersion(name, version ? Number(version) : undefined);
        mkdirSync(dirname(resolve(out)), { recursive: true });
        writeFileSync(
          resolve(out),
          JSON.stringify(
            {
              name: data.setName,
              version: data.version,
              rawInputs: data.rawInputs,
              result: data.result,
              exportedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          'utf-8',
        );
        print(`已导出 ${data.result.blocks.length} 个网段、${data.result.totalAddresses} 个地址到 ${out}`);
      } finally {
        store.close();
      }
      return;
    }
    default: {
      print(USAGE);
      if (command && command !== 'help') process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof CidrError) {
    process.stderr.write(`错误 [${error.code}]: ${error.message}\n`);
    if (error.index !== undefined) {
      process.stderr.write(`位置: 第 ${error.index + 1} 项，输入 "${error.input}"\n`);
    }
  } else {
    process.stderr.write(`错误 [INTERNAL_ERROR]: ${(error as Error).stack ?? (error as Error).message}\n`);
  }
  process.exit(1);
});
