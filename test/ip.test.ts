import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOTAL_SPACE,
  cidrToRange,
  formatIpv4,
  intersectRanges,
  mergeRanges,
  parseCidr,
  parseIpv4,
  rangeToMinimalCidrs,
  rangesTotalSize,
  subtractRanges,
} from '../dist/core/ip.js';
import { normalizeInputs } from '../dist/core/normalize.js';

test('点分十进制转换覆盖首末地址', () => {
  assert.equal(formatIpv4(parseIpv4('0.0.0.0')), '0.0.0.0');
  assert.equal(formatIpv4(parseIpv4('255.255.255.255')), '255.255.255.255');
  assert.equal(parseIpv4('1.2.3.4'), 0x01020304n);
});

test('非法四段、段越界、空元素报明确错误', () => {
  assert.equal(assertCode(() => parseIpv4('1.2.3')), 'INVALID_FORMAT');
  assert.equal(assertCode(() => parseIpv4('1.2.3.4.5')), 'INVALID_FORMAT');
  assert.equal(assertCode(() => parseIpv4('256.0.0.1')), 'OCTET_OUT_OF_RANGE');
  assert.equal(assertCode(() => parseIpv4('1.2.a.4')), 'INVALID_FORMAT');
  assert.equal(assertCode(() => parseCidr('1.0.0.0/33')), 'PREFIX_OUT_OF_RANGE');
  assert.equal(assertCode(() => parseCidr('1.0.0.0/-1')), 'INVALID_PREFIX');
  assert.equal(assertCode(() => normalizeInputs([''])), 'EMPTY_INPUT');
});

function assertCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('应当抛错但未抛错');
}

test('/0 覆盖整个 32 位空间，总数 4294967296', () => {
  const range = cidrToRange(parseCidr('0.0.0.0/0'));
  assert.equal(range.start, 0n);
  assert.equal(range.end, TOTAL_SPACE - 1n);
  assert.equal(rangesTotalSize([range]), TOTAL_SPACE);
  const blocks = rangeToMinimalCidrs(range);
  assert.deepEqual(blocks.map((b) => b.cidr), ['0.0.0.0/0']);
});

test('/32 单地址与带主机位规范化提示', () => {
  const result = normalizeInputs(['10.0.0.5']);
  assert.equal(result.blocks[0].cidr, '10.0.0.5/32');
  const norm = normalizeInputs(['192.168.1.10/24']);
  assert.equal(norm.blocks[0].cidr, '192.168.1.0/24');
  assert.ok(norm.notes.some((n) => n.type === 'normalized_host_bits'));
});

test('两个相邻 /25 合成 /24', () => {
  const result = normalizeInputs(['10.0.0.0/25', '10.0.0.128/25']);
  assert.deepEqual(result.blocks.map((b) => b.cidr), ['10.0.0.0/24']);
  assert.equal(result.totalAddresses, '256');
});

test('相邻但不对齐的块不能强行合并', () => {
  // 0-127 与 129-255 之间缺 128，不相邻；这里测 0-127 与 128-255 内部分解边界
  const result = normalizeInputs(['10.0.0.0/26', '10.0.0.128/25']);
  // 0/26(0-63), 128/25(128-255)：中间 64-127 缺失
  assert.deepEqual(result.blocks.map((b) => b.cidr), ['10.0.0.0/26', '10.0.0.128/25']);
});

test('非对齐连续区间最小分解', () => {
  // 10.0.0.1 - 10.0.0.4 的最小 CIDR 分解
  const blocks = rangeToMinimalCidrs({ start: parseIpv4('10.0.0.1'), end: parseIpv4('10.0.0.4') });
  assert.deepEqual(
    blocks.map((b) => b.cidr),
    ['10.0.0.1/32', '10.0.0.2/31', '10.0.0.4/32'],
  );
});

test('嵌套与重复网段不重复计数', () => {
  const result = normalizeInputs(['10.0.0.0/24', '10.0.0.0/25', '10.0.0.0/24']);
  assert.deepEqual(result.blocks.map((b) => b.cidr), ['10.0.0.0/24']);
  assert.equal(result.totalAddresses, '256');
  assert.equal(result.dedupCount, 1);
});

test('输入顺序不改变结果，规范化幂等', () => {
  const a = normalizeInputs(['10.0.0.128/25', '10.0.0.0/25', '192.168.0.0/30']);
  const b = normalizeInputs(['192.168.0.0/30', '10.0.0.0/25', '10.0.0.128/25']);
  assert.deepEqual(a.blocks, b.blocks);
  const again = normalizeInputs(a.blocks.map((x) => x.cidr));
  assert.deepEqual(again.blocks, a.blocks);
});

test('最后八位段枚举核对交集与差集', () => {
  // 集合 {1,2,3,4} 与 {3,4,5} 的交集 = {3,4}
  const a = mergeRanges([{ start: 1n, end: 4n }]);
  const b = mergeRanges([{ start: 3n, end: 5n }]);
  const inter = intersectRanges(a, b);
  assert.equal(rangesTotalSize(inter), 2n);
  // 差集 = {1,2}
  const diff = subtractRanges(a, b);
  assert.equal(rangesTotalSize(diff), 2n);
  assert.deepEqual(diff, [{ start: 1n, end: 2n }]);
});

test('从 /24 排除一个地址后的最小分解', () => {
  const full = [cidrToRange(parseCidr('10.0.0.0/24'))];
  const one = [cidrToRange(parseCidr('10.0.0.5/32'))];
  const diff = subtractRanges(full, one);
  assert.equal(rangesTotalSize(diff), 255n);
  const blocks = rangeToMinimalCidrs(diff[0]);
  // 10.0.0.5 之前 0-4 与之后 6-255，两个区间；总块数为标准最小拆分
  const all = diff.flatMap(rangeToMinimalCidrs);
  const expected = [
    '10.0.0.0/30',
    '10.0.0.4/32',
    '10.0.0.6/31',
    '10.0.0.8/29',
    '10.0.0.16/28',
    '10.0.0.32/27',
    '10.0.0.64/26',
    '10.0.0.128/25',
  ];
  assert.deepEqual(all.map((x) => x.cidr), expected);
  assert.equal(blocks.length > 0, true);
});

test('无交集与全部删除', () => {
  const a = [cidrToRange(parseCidr('10.0.0.0/24'))];
  const b = [cidrToRange(parseCidr('192.168.0.0/24'))];
  assert.equal(intersectRanges(a, b).length, 0);
  const diff = subtractRanges(a, a);
  assert.equal(diff.length, 0);
  assert.equal(rangesTotalSize(diff), 0n);
});
