// IPv4 纯函数运算核心。
// 全部地址以无符号 32 位 BigInt 表示，避免 JavaScript 位运算的有符号结果。

export const IPV4_MIN = 0n;
export const IPV4_MAX = 0xffffffffn;
export const TOTAL_SPACE = 0x100000000n; // 4294967296

export interface AppError {
  code: string;
  message: string;
  index?: number;
  input?: string;
}

export class CidrError extends Error {
  readonly code: string;
  readonly index?: number;
  readonly input?: string;
  constructor(code: string, message: string, index?: number, input?: string) {
    super(message);
    this.name = 'CidrError';
    this.code = code;
    this.index = index;
    this.input = input;
  }
  toJSON(): AppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.index === undefined ? {} : { index: this.index }),
      ...(this.input === undefined ? {} : { input: this.input }),
    };
  }
}

/** 严格解析点分十进制：恰好 4 段，每段 0-255，禁止空段/前导加号/空格以外的修饰。 */
export function parseIpv4(text: string): bigint {
  if (typeof text !== 'string') {
    throw new CidrError('INVALID_FORMAT', '地址必须是字符串');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CidrError('EMPTY_INPUT', '地址为空');
  }
  const parts = trimmed.split('.');
  if (parts.length !== 4) {
    throw new CidrError('INVALID_FORMAT', `非法四段格式 "${text}"：应为 a.b.c.d`, undefined, text);
  }
  let value = 0n;
  for (const part of parts) {
    if (part === '' || !/^\d+$/.test(part)) {
      throw new CidrError('INVALID_FORMAT', `非法四段格式 "${text}"：每段必须是非负整数`, undefined, text);
    }
    // 禁止前导零可能会误伤常见写法，这里允许 "01" 但按十进制解析；明确拒绝 "+1"/负数已由正则排除。
    const octet = Number(part);
    if (octet > 255) {
      throw new CidrError('OCTET_OUT_OF_RANGE', `地址段越界 "${text}"：每段必须在 0-255 之间`, undefined, text);
    }
    value = value * 256n + BigInt(octet);
  }
  return value;
}

export function formatIpv4(value: bigint): string {
  if (value < IPV4_MIN || value > IPV4_MAX) {
    throw new CidrError('VALUE_OUT_OF_RANGE', `地址数值越界：${value}`);
  }
  const octets: number[] = [];
  let rest = value;
  for (let i = 0; i < 4; i++) {
    octets.push(Number(rest % 256n));
    rest /= 256n;
  }
  return octets.reverse().join('.');
}

export interface ParsedCidr {
  ip: bigint;
  prefix: number;
  normalized: boolean;
  original: string;
}

/** 解析单个地址或 CIDR。裸地址按 /32 处理；带主机位时标记 normalized=true，但不抛错。 */
export function parseCidr(raw: string, index?: number): ParsedCidr {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CidrError('EMPTY_INPUT', '存在空元素', index, raw);
  }
  const text = raw.trim();
  const slash = text.indexOf('/');
  let addrText = text;
  let prefix = 32;
  if (slash !== -1) {
    addrText = text.slice(0, slash);
    const prefixText = text.slice(slash + 1);
    if (!/^\d+$/.test(prefixText)) {
      throw new CidrError('INVALID_PREFIX', `前缀长度非法 "${raw}"：必须是 0-32 的整数`, index, raw);
    }
    prefix = Number(prefixText);
    if (prefix < 0 || prefix > 32) {
      throw new CidrError('PREFIX_OUT_OF_RANGE', `前缀越界 "${raw}"：前缀长度必须在 0-32 之间`, index, raw);
    }
  }
  const ip = parseIpv4(addrText);
  const hostMask = prefix === 32 ? 0n : (1n << BigInt(32 - prefix)) - 1n;
  const network = ip & ~hostMask;
  return {
    ip: network,
    prefix,
    normalized: network !== ip,
    original: raw,
  };
}

export interface CidrBlock {
  start: bigint;
  end: bigint; // 含端点
}

export function cidrToRange(parsed: ParsedCidr): CidrBlock {
  const size = parsed.prefix === 32 ? 1n : 1n << BigInt(32 - parsed.prefix);
  return { start: parsed.ip, end: parsed.ip + size - 1n };
}

export function rangeSize(range: CidrBlock): bigint {
  return range.end - range.start + 1n;
}

/** 合并重叠或相邻（end1 + 1 == start2）的区间，输出有序且互不相交。 */
export function mergeRanges(ranges: CidrBlock[]): CidrBlock[] {
  const sorted = [...ranges].sort((a, b) =>
    a.start === b.start ? (a.end < b.end ? 1 : a.end > b.end ? -1 : 0) : a.start < b.start ? -1 : 1,
  );
  const merged: CidrBlock[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1n) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

export interface CidrOut {
  cidr: string;
  start: string;
  end: string;
  size: string;
}

/**
 * 将一个连续区间分解为数量最少、按起始地址排序的对齐 CIDR。
 * 区间必须位于 [0, 2^32-1]；/0 的整体空间也能正确处理。
 */
export function rangeToMinimalCidrs(range: CidrBlock): CidrOut[] {
  if (range.start < IPV4_MIN || range.end > IPV4_MAX || range.start > range.end) {
    throw new CidrError('VALUE_OUT_OF_RANGE', `非法区间：${range.start}-${range.end}`);
  }
  const blocks: CidrOut[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    const maxBySpace = floorPowerOfTwo(range.end - cursor + 1n);
    const maxByAlignment = cursor === 0n ? TOTAL_SPACE : lowbit(cursor);
    const size = maxBySpace < maxByAlignment ? maxBySpace : maxByAlignment;
    const prefix = 32 - log2(size);
    const end = cursor + size - 1n;
    blocks.push({
      cidr: `${formatIpv4(cursor)}/${prefix}`,
      start: formatIpv4(cursor),
      end: formatIpv4(end),
      size: size.toString(),
    });
    cursor = end + 1n;
  }
  return blocks;
}

function lowbit(value: bigint): bigint {
  return value & -value;
}

function floorPowerOfTwo(value: bigint): bigint {
  let p = 1n;
  while (p * 2n <= value) p *= 2n;
  return p;
}

function log2(value: bigint): number {
  let n = 0;
  let v = value;
  while (v > 1n) {
    v >>= 1n;
    n++;
  }
  return n;
}

/** A 减 B：绝不扩大 A，输出合并后的区间。 */
export function subtractRanges(a: CidrBlock[], b: CidrBlock[]): CidrBlock[] {
  const result: CidrBlock[] = [];
  const subs = mergeRanges(b);
  for (const block of mergeRanges(a)) {
    let pieces: CidrBlock[] = [{ ...block }];
    for (const cut of subs) {
      const next: CidrBlock[] = [];
      for (const piece of pieces) {
        if (cut.end < piece.start || cut.start > piece.end) {
          next.push(piece);
        } else {
          if (cut.start > piece.start) next.push({ start: piece.start, end: cut.start - 1n });
          if (cut.end < piece.end) next.push({ start: cut.end + 1n, end: piece.end });
        }
      }
      pieces = next;
    }
    result.push(...pieces);
  }
  return mergeRanges(result);
}

/** 交集：输出同时属于 A、B 的区间。 */
export function intersectRanges(a: CidrBlock[], b: CidrBlock[]): CidrBlock[] {
  const left = mergeRanges(a);
  const right = mergeRanges(b);
  const result: CidrBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const x = left[i];
    const y = right[j];
    const start = x.start > y.start ? x.start : y.start;
    const end = x.end < y.end ? x.end : y.end;
    if (start <= end) result.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return result;
}

export function rangesTotalSize(ranges: CidrBlock[]): bigint {
  let total = 0n;
  for (const range of ranges) total += rangeSize(range);
  return total;
}

export function rangesToBlocks(ranges: CidrBlock[]): CidrOut[] {
  return mergeRanges(ranges).flatMap(rangeToMinimalCidrs);
}

/** 判断地址是否落在区间集合内。 */
export function containsIp(ranges: CidrBlock[], ip: bigint): boolean {
  return mergeRanges(ranges).some((range) => ip >= range.start && ip <= range.end);
}
