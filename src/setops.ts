import {
  CidrError,
  Range,
  cidrRange,
  formatCidr,
  formatIPv4,
  intersectRanges,
  mergeRanges,
  parseCidr,
  rangesToCidrs,
  rangesTotal,
  subtractRanges,
} from "./ipv4";

export interface NormalizedItem {
  input: string;
  cidr: string;
  normalized: boolean;
}

export interface ComputeResult {
  cidrs: string[];
  total: number; // 精确到 2^32，JSON 序列化为数字（double 精确）
  notes: string[];
}

function toRanges(items: string[]): { ranges: Range[]; normalized: NormalizedItem[]; notes: string[] } {
  if (!Array.isArray(items) || items.length === 0) {
    throw new CidrError("EMPTY_ITEMS", "元素列表不能为空");
  }
  const ranges: Range[] = [];
  const normalized: NormalizedItem[] = [];
  const notes: string[] = [];
  for (const raw of items) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new CidrError("EMPTY_ELEMENT", `存在空元素: ${JSON.stringify(raw)}`);
    }
    const parsed = parseCidr(raw.trim());
    const [s, e] = cidrRange(parsed.network, parsed.prefix);
    ranges.push([s, e]);
    const cidr = formatCidr(parsed.network, parsed.prefix);
    normalized.push({ input: raw, cidr, normalized: parsed.hadHostBits });
    if (parsed.hadHostBits) {
      notes.push(`"${raw}" 带主机位，已按掩码规范化为 ${cidr}`);
    }
  }
  return { ranges, normalized, notes };
}

function summarize(ranges: Range[], notes: string[]): ComputeResult {
  const merged = mergeRanges(ranges);
  const cidrs = rangesToCidrs(merged).map((c) => formatCidr(c.network, c.prefix));
  const out = notes.slice();
  if (merged.length > 1) {
    out.push(`覆盖 ${merged.length} 个不相邻区间，无法进一步合并`);
  }
  return { cidrs, total: rangesTotal(merged), notes: out };
}

export function normalizeSet(items: string[]): ComputeResult & { normalized: NormalizedItem[] } {
  const { ranges, normalized, notes } = toRanges(items);
  return { ...summarize(ranges, notes), normalized };
}

export function unionRangesOf(items: string[]): Range[] {
  return mergeRanges(toRanges(items).ranges);
}

export function intersectSets(aItems: string[], bItems: string[]): ComputeResult {
  const a = toRanges(aItems);
  const b = toRanges(bItems);
  const inter = intersectRanges(a.ranges, b.ranges);
  const notes = a.notes.concat(b.notes);
  if (inter.length === 0) notes.push("两集合无交集");
  return summarize(inter, notes);
}

export function subtractSets(aItems: string[], bItems: string[]): ComputeResult {
  const a = toRanges(aItems);
  const b = toRanges(bItems);
  const diff = subtractRanges(a.ranges, b.ranges);
  const notes = a.notes.concat(b.notes);
  const removed = rangesTotal(a.ranges) - rangesTotal(diff);
  if (removed === 0) notes.push("减集与被减集无重叠，结果与原集合相同");
  else if (diff.length === 0) notes.push("全部地址被排除，结果为空集");
  else notes.push(`共排除 ${removed} 个地址`);
  return summarize(diff, notes);
}

export type Membership = "kept" | "excluded" | "never";

export function membershipOf(ipText: string, rawItems: string[], resultItems: string[]): Membership {
  const ip = parseCidr(ipText.trim());
  if (ip.prefix !== 32) {
    throw new CidrError("INVALID_QUERY", "归属查询只接受单个地址（/32）");
  }
  const target: Range = [ip.network, ip.network];
  const inRaw = intersectRanges([target], unionRangesOf(rawItems)).length > 0;
  const inResult = intersectRanges([target], unionRangesOf(resultItems)).length > 0;
  if (inResult) return "kept";
  return inRaw ? "excluded" : "never";
}

export { formatIPv4 };
