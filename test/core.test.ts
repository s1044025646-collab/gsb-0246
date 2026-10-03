import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CidrError,
  formatIPv4,
  intersectRanges,
  mergeRanges,
  parseCidr,
  parseIPv4,
  rangesToCidrs,
  rangesTotal,
  subtractRanges,
  Range,
} from "../src/ipv4";
import { intersectSets, membershipOf, normalizeSet, subtractSets } from "../src/setops";

test("parseIPv4 严格校验", () => {
  assert.equal(parseIPv4("0.0.0.0"), 0);
  assert.equal(parseIPv4("255.255.255.255"), 4294967295);
  assert.equal(parseIPv4("10.0.0.1"), 167772161);
  for (const bad of ["1.2.3", "1.2.3.4.5", "1.2.3.256", "01.2.3.4", "a.b.c.d", "", "1.2.3.-1", "1.2.3.4 "]) {
    assert.throws(() => parseIPv4(bad), CidrError, `应拒绝: "${bad}"`);
  }
});

test("CIDR 前缀校验", () => {
  assert.throws(() => parseCidr("10.0.0.0/33"), /越界/);
  assert.throws(() => parseCidr("10.0.0.0/-1"), /非法前缀/);
  assert.throws(() => parseCidr("10.0.0.0/abc"), /非法前缀/);
  assert.throws(() => parseCidr("10.0.0.0/24/1"), /只能包含一个/);
});

test("带主机位的 CIDR 被规范化并提示", () => {
  const p = parseCidr("10.0.0.1/24");
  assert.equal(p.hadHostBits, true);
  assert.equal(formatIPv4(p.network), "10.0.0.0");
  const r = normalizeSet(["10.0.0.1/24"]);
  assert.deepEqual(r.cidrs, ["10.0.0.0/24"]);
  assert.ok(r.notes.some((n) => n.includes("规范化")));
});

test("/0 覆盖全空间，总数精确为 4294967296", () => {
  const r = normalizeSet(["0.0.0.0/0"]);
  assert.deepEqual(r.cidrs, ["0.0.0.0/0"]);
  assert.equal(r.total, 4294967296);
  assert.equal(JSON.parse(JSON.stringify(r)).total, 4294967296);
});

test("首末地址与 /32", () => {
  const r = normalizeSet(["0.0.0.0", "255.255.255.255"]);
  assert.deepEqual(r.cidrs, ["0.0.0.0/32", "255.255.255.255/32"]);
  assert.equal(r.total, 2);
});

test("两个相邻 /25 合成 /24", () => {
  const r = normalizeSet(["10.0.0.0/25", "10.0.0.128/25"]);
  assert.deepEqual(r.cidrs, ["10.0.0.0/24"]);
  assert.equal(r.total, 256);
});

test("非对齐相邻块不能强行合并", () => {
  const r = normalizeSet(["10.0.0.1", "10.0.0.2"]);
  assert.deepEqual(r.cidrs, ["10.0.0.1/32", "10.0.0.2/32"]);
  const r2 = normalizeSet(["10.0.0.2", "10.0.0.3"]);
  assert.deepEqual(r2.cidrs, ["10.0.0.2/31"]);
});

test("嵌套与重复不重复计数", () => {
  const r = normalizeSet(["10.0.0.0/24", "10.0.0.0/25", "10.0.0.0/24", "10.0.0.9"]);
  assert.deepEqual(r.cidrs, ["10.0.0.0/24"]);
  assert.equal(r.total, 256);
});

test("从 /24 排除一个地址", () => {
  const r = subtractSets(["10.0.0.0/24"], ["10.0.0.5"]);
  assert.equal(r.total, 255);
  assert.deepEqual(r.cidrs, [
    "10.0.0.0/30",
    "10.0.0.4/32",
    "10.0.0.6/31",
    "10.0.0.8/29",
    "10.0.0.16/28",
    "10.0.0.32/27",
    "10.0.0.64/26",
    "10.0.0.128/25",
  ]);
});

test("差集与另一个网段求交", () => {
  const diff = subtractSets(["10.0.0.0/24"], ["10.0.0.5"]);
  const inter = intersectSets(diff.cidrs, ["10.0.0.64/26"]);
  assert.deepEqual(inter.cidrs, ["10.0.0.64/26"]);
  assert.equal(inter.total, 64);
});

test("全部删除得到空集", () => {
  const r = subtractSets(["10.0.0.0/24"], ["10.0.0.0/24"]);
  assert.deepEqual(r.cidrs, []);
  assert.equal(r.total, 0);
  assert.ok(r.notes.some((n) => n.includes("空集")));
});

test("无交集", () => {
  const r = intersectSets(["10.0.0.0/24"], ["10.0.1.0/24"]);
  assert.deepEqual(r.cidrs, []);
  assert.equal(r.total, 0);
  assert.ok(r.notes.some((n) => n.includes("无交集")));
});

test("差集不扩大原集合", () => {
  const r = subtractSets(["10.0.0.0/25"], ["192.168.0.0/16"]);
  assert.deepEqual(r.cidrs, ["10.0.0.0/25"]);
  assert.equal(r.total, 128);
});

test("跨边界减法：/0 减去中间段", () => {
  const r = subtractSets(["0.0.0.0/0"], ["10.0.0.0/8"]);
  assert.equal(r.total, 4294967296 - 16777216);
  assert.ok(r.cidrs.length > 1);
  assert.ok(!r.cidrs.some((c) => c.startsWith("10.")));
});

function enumerate(cidrTexts: string[]): Set<number> {
  const set = new Set<number>();
  for (const t of cidrTexts) {
    const p = parseCidr(t);
    const size = Math.pow(2, 32 - p.prefix);
    for (let i = 0; i < size; i++) set.add(p.network + i);
  }
  return set;
}

function cidrsOf(set: Set<number>): string[] {
  const ranges: Range[] = [...set].sort((a, b) => a - b).map((v) => [v, v] as Range);
  return rangesToCidrs(ranges).map((c) => `${formatIPv4(c.network)}/${c.prefix}`);
}

test("小范围直接枚举核对归并/交集/差集/最小覆盖", () => {
  // 限定在最后一个八位段内：10.0.0.0/24 空间
  const cases: string[][] = [
    ["10.0.0.0/25", "10.0.0.128/25"],
    ["10.0.0.0/24", "10.0.0.0/24"],
    ["10.0.0.10", "10.0.0.11", "10.0.0.12", "10.0.0.13"],
    ["10.0.0.0/26", "10.0.0.32/27", "10.0.0.200/29"],
    ["10.0.0.0/24", "10.0.0.0/25", "10.0.0.0/26"],
  ];
  for (const items of cases) {
    const expected = enumerate(items);
    const got = normalizeSet(items);
    assert.deepEqual(enumerate(got.cidrs), expected, `归并覆盖应一致: ${items}`);
    assert.equal(got.total, expected.size);
    // 最小覆盖：再次归并不变（幂等）
    if (got.cidrs.length) assert.deepEqual(normalizeSet(got.cidrs).cidrs, got.cidrs);
    // 顺序无关
    const shuffled = items.slice().reverse();
    assert.deepEqual(normalizeSet(shuffled).cidrs, got.cidrs);
  }
  // 交集/差集枚举核对
  const pairs: Array<[string[], string[]]> = [
    [["10.0.0.0/24"], ["10.0.0.5"]],
    [["10.0.0.0/25"], ["10.0.0.64/26"]],
    [["10.0.0.0/24"], ["10.0.0.0/24"]],
    [["10.0.0.0/26"], ["10.0.0.128/26"]],
    [["10.0.0.0/24", "10.0.0.200/29"], ["10.0.0.192/28"]],
  ];
  for (const [a, b] of pairs) {
    const ea = enumerate(a);
    const eb = enumerate(b);
    const inter = intersectSets(a, b);
    const expectedInter = new Set([...ea].filter((x) => eb.has(x)));
    assert.deepEqual(enumerate(inter.cidrs), expectedInter, `交集: ${a} ∩ ${b}`);
    assert.equal(inter.total, expectedInter.size);
    const diff = subtractSets(a, b);
    const expectedDiff = new Set([...ea].filter((x) => !eb.has(x)));
    assert.deepEqual(enumerate(diff.cidrs), expectedDiff, `差集: ${a} - ${b}`);
    assert.equal(diff.total, expectedDiff.size);
    // 最小性：差集再归并结果不变
    if (diff.cidrs.length) assert.deepEqual(normalizeSet(diff.cidrs).cidrs, diff.cidrs);
  }
});

test("最小 CIDR 分解与 rangesTotal 的底层性质", () => {
  // 全空间拆分
  const full = rangesToCidrs([[0, 4294967295]]);
  assert.deepEqual(full.map((c) => c.prefix), [0]);
  // 相邻区间合并
  assert.deepEqual(mergeRanges([[0, 9], [10, 20]]), [[0, 20]]);
  // 区间运算与枚举一致（随机小样本）
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let t = 0; t < 200; t++) {
    const mk = (): Range[] =>
      Array.from({ length: 1 + rand(4) }, () => {
        const s = rand(256);
        return [s, s + rand(64)] as Range;
      });
    const a = mk();
    const b = mk();
    const ea = new Set<number>();
    const eb = new Set<number>();
    for (const [s, e] of a) for (let i = s; i <= e; i++) ea.add(i);
    for (const [s, e] of b) for (let i = s; i <= e; i++) eb.add(i);
    const uni = mergeRanges(a.concat(b));
    assert.equal(rangesTotal(uni), ea.size + eb.size - [...ea].filter((x) => eb.has(x)).length);
    const inter = intersectRanges(a, b);
    assert.equal(rangesTotal(inter), [...ea].filter((x) => eb.has(x)).length);
    const diff = subtractRanges(a, b);
    assert.equal(rangesTotal(diff), [...ea].filter((x) => !eb.has(x)).length);
    // 分解再展开应还原
    const decomposed = rangesToCidrs(diff);
    const back = new Set<number>();
    for (const c of decomposed) {
      const size = Math.pow(2, 32 - c.prefix);
      for (let i = 0; i < size; i++) back.add(c.network + i);
    }
    assert.deepEqual(back, new Set([...ea].filter((x) => !eb.has(x))));
  }
});

test("归属查询 kept/excluded/never", () => {
  const raw = ["10.0.0.0/24"];
  const result = subtractSets(raw, ["10.0.0.5"]).cidrs;
  assert.equal(membershipOf("10.0.0.1", raw, result), "kept");
  assert.equal(membershipOf("10.0.0.5", raw, result), "excluded");
  assert.equal(membershipOf("10.0.1.1", raw, result), "never");
  assert.throws(() => membershipOf("10.0.0.0/24", raw, result), /单个地址/);
});

test("错误输入不产生结果", () => {
  assert.throws(() => normalizeSet([]), /不能为空/);
  assert.throws(() => normalizeSet(["10.0.0.0/24", ""]), CidrError);
  assert.throws(() => normalizeSet(["10.0.0.0/24", "999.1.1.1"]), CidrError);
});

