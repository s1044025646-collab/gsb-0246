// IPv4 核心运算：全部使用 number 算术（2^32 在 double 精度内精确），
// 不使用 JavaScript 位运算，避免 32 位有符号结果的干扰。

export const IPV4_SPACE = 4294967296; // 2^32

export class CidrError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CidrError";
  }
}

/** 严格解析点分十进制 IPv4，返回 0..2^32-1 的数值。 */
export function parseIPv4(text: string): number {
  if (typeof text !== "string") {
    throw new CidrError("INVALID_IP", `地址必须是字符串: ${String(text)}`);
  }
  const parts = text.split(".");
  if (parts.length !== 4) {
    throw new CidrError("INVALID_IP", `非法 IPv4 格式（需要四段点分十进制）: "${text}"`);
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new CidrError("INVALID_IP", `非法 IPv4 八位段 "${part}"（在 "${text}" 中）`);
    }
    if (part.length > 1 && part.startsWith("0")) {
      throw new CidrError("INVALID_IP", `八位段不允许前导零 "${part}"（在 "${text}" 中），避免歧义`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new CidrError("INVALID_IP", `八位段越界 "${part}"（在 "${text}" 中），应在 0-255`);
    }
    value = value * 256 + octet;
  }
  return value;
}

export function formatIPv4(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= IPV4_SPACE) {
    throw new CidrError("INVALID_IP_VALUE", `非法 IPv4 数值: ${value}`);
  }
  const a = Math.floor(value / 16777216);
  const b = Math.floor((value % 16777216) / 65536);
  const c = Math.floor((value % 65536) / 256);
  const d = value % 256;
  return `${a}.${b}.${c}.${d}`;
}

export interface ParsedCidr {
  network: number;
  prefix: number;
  hadHostBits: boolean;
}

export function parseCidr(text: string): ParsedCidr {
  const slash = text.indexOf("/");
  if (slash < 0) {
    const ip = parseIPv4(text.trim());
    return { network: ip, prefix: 32, hadHostBits: false };
  }
  if (text.indexOf("/", slash + 1) >= 0) {
    throw new CidrError("INVALID_CIDR", `CIDR 只能包含一个 "/": "${text}"`);
  }
  const ipPart = text.slice(0, slash).trim();
  const prefixPart = text.slice(slash + 1).trim();
  if (!/^\d{1,2}$/.test(prefixPart)) {
    throw new CidrError("INVALID_PREFIX", `非法前缀长度 "${prefixPart}"（在 "${text}" 中）`);
  }
  const prefix = Number(prefixPart);
  if (prefix > 32) {
    throw new CidrError("INVALID_PREFIX", `前缀长度越界 ${prefix}（在 "${text}" 中），应在 0-32`);
  }
  const ip = parseIPv4(ipPart);
  const size = Math.pow(2, 32 - prefix);
  const network = ip - (ip % size);
  return { network, prefix, hadHostBits: network !== ip };
}

export function cidrRange(network: number, prefix: number): [number, number] {
  const size = Math.pow(2, 32 - prefix);
  return [network, network + size - 1];
}

export function formatCidr(network: number, prefix: number): string {
  return `${formatIPv4(network)}/${prefix}`;
}

/** 闭区间 [start, end]，数值均为无符号 32 位整数。 */
export type Range = [number, number];

/** 排序并合并重叠/相邻区间，返回互不重叠且不可再合并的区间列表。 */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter((r) => r[0] <= r[1])
    .slice()
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** base - minus，结果不会超出 base 的覆盖范围。 */
export function subtractRanges(base: Range[], minus: Range[]): Range[] {
  let current = mergeRanges(base);
  for (const [ms, me] of mergeRanges(minus)) {
    const next: Range[] = [];
    for (const [s, e] of current) {
      if (me < s || ms > e) {
        next.push([s, e]);
        continue;
      }
      if (ms > s) next.push([s, ms - 1]);
      if (me < e) next.push([me + 1, e]);
    }
    current = next;
  }
  return current;
}

export function intersectRanges(a: Range[], b: Range[]): Range[] {
  const ma = mergeRanges(a);
  const mb = mergeRanges(b);
  const out: Range[] = [];
  let i = 0;
  let j = 0;
  while (i < ma.length && j < mb.length) {
    const s = Math.max(ma[i][0], mb[j][0]);
    const e = Math.min(ma[i][1], mb[j][1]);
    if (s <= e) out.push([s, e]);
    if (ma[i][1] < mb[j][1]) i++;
    else j++;
  }
  return out;
}

function trailingZeros(v: number): number {
  let count = 0;
  while (v % 2 === 0) {
    v /= 2;
    count++;
  }
  return count;
}

/** 把单个闭区间分解为最小数量的对齐 CIDR 块。 */
export function rangeToCidrs(start: number, end: number): ParsedCidr[] {
  const out: ParsedCidr[] = [];
  let cur = start;
  while (cur <= end) {
    let maxSize = cur === 0 ? IPV4_SPACE : Math.pow(2, trailingZeros(cur));
    const remaining = end - cur + 1;
    while (maxSize > remaining) maxSize /= 2;
    const prefix = 32 - Math.round(Math.log2(maxSize));
    out.push({ network: cur, prefix, hadHostBits: false });
    cur += maxSize;
  }
  return out;
}

export function rangesToCidrs(ranges: Range[]): ParsedCidr[] {
  const out: ParsedCidr[] = [];
  for (const [s, e] of mergeRanges(ranges)) {
    out.push(...rangeToCidrs(s, e));
  }
  return out;
}

export function rangesTotal(ranges: Range[]): number {
  return mergeRanges(ranges).reduce((sum, [s, e]) => sum + (e - s + 1), 0);
}
