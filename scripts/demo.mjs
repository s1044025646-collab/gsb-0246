// 端到端演示：构建后用编译产物直接操作临时数据目录。
// 运行：npm run build && npm run demo
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = join(tmpdir(), 'cidr-demo');
rmSync(dataDir, { recursive: true, force: true });
process.env.DATA_DIR = dataDir;

const cli = 'node dist/cli.js';
const run = (args) => {
  console.log(`\n$ ${cli} ${args}`);
  const output = execFileSync('node', ['--no-warnings', 'dist/cli.js', ...args.split(' ')], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf-8',
  });
  console.log(output.trimEnd());
  return output;
};

console.log('=== 1) 两个相邻 /25 合成 /24（不保存，仅归并）===');
run('normalize --inputs 192.168.1.0/25,192.168.1.128/25');

console.log('\n=== 2) 保存集合 full=192.168.1.0/24 与 one=192.168.1.5/32 ===');
run('import --name full --inputs 192.168.1.0/24');
run('import --name one --inputs 192.168.1.5/32');

console.log('\n=== 3) 从 /24 中排除一个地址（差集）===');
run('diff --left full --right one');

console.log('\n=== 4) 保存 small 并与 full 求交 ===');
run('import --name small --inputs 192.168.1.0/30,192.168.1.4/31');
run('intersect --left small --right full');

console.log('\n=== 5) 成员查询：被排除地址 ===');
run('import --name full --inputs 192.168.1.128/25');
run('member full --address 192.168.1.5');
run('member full --address 192.168.1.200');
run('member full --address 8.8.8.8');

console.log('\n=== 6) 非对齐相邻范围保持拆分 ===');
run('normalize --inputs 10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4');

console.log('\n=== 7) 错误输入示例 ===');
try {
  run('normalize --inputs 10.0.0.0/40');
} catch (error) {
  console.log(error.stderr ? error.stderr.trim() : error.message);
}

console.log(`\n演示数据库位于：${dataDir}`);
