import {
  CidrBlock,
  CidrError,
  CidrOut,
  cidrToRange,
  containsIp,
  formatIpv4,
  intersectRanges,
  mergeRanges,
  parseCidr,
  parseIpv4,
  rangeSize,
  rangesToBlocks,
  rangesTotalSize,
  subtractRanges,
} from './ip.js';

export interface NormalizeNote {
  type: 'normalized_host_bits' | 'merged_adjacent' | 'duplicate' | 'info';
  message: string;
}

export interface NormalizeResult {
  inputs: string[];
  blocks: CidrOut[];
  totalAddresses: string;
  inputCount: number;
  dedupCount: number;
  notes: NormalizeNote[];
}

/**
 * 归并原始条目：解析、规范化带主机位的 CIDR、去重、合并重叠/相邻区间、最小 CIDR 分解。
 * 非法输入立即抛错，不产生任何成功记录。
 */
export function normalizeInputs(rawInputs: string[]): NormalizeResult {
  if (!Array.isArray(rawInputs)) {
    throw new CidrError('INVALID_REQUEST', 'inputs 必须是字符串数组');
  }
  if (rawInputs.length === 0) {
    throw new CidrError('EMPTY_INPUT', '输入为空：至少需要一个地址或 CIDR');
  }

  const notes: NormalizeNote[] = [];
  const seen = new Set<string>();
  const ranges: CidrBlock[] = [];
  let dedupCount = 0;

  rawInputs.forEach((raw, index) => {
    const parsed = parseCidr(raw, index);
    const key = `${parsed.ip}/${parsed.prefix}`;
    if (seen.has(key)) {
      dedupCount++;
      notes.push({
        type: 'duplicate',
        message: `第 ${index + 1} 项 "${raw}" 与已规范化的 ${key} 重复，仅计数一次`,
      });
      return;
    }
    seen.add(key);
    if (parsed.normalized) {
      notes.push({
        type: 'normalized_host_bits',
        message: `"${raw}" 带有主机位，已规范化为 ${key}（不静默改成其他地址）`,
      });
    }
    ranges.push(cidrToRange(parsed));
  });

  const before = mergeRanges(ranges);
  const blocks = rangesToBlocks(before);

  const mergeCount = before.length - blocks.length;
  if (mergeCount > 0) {
    notes.push({
      type: 'merged_adjacent',
      message: `${before.length} 个连续区间分解为 ${blocks.length} 个最小对齐 CIDR（相邻对齐块已合并，非对齐边界被拆分）`,
    });
  } else {
    notes.push({
      type: 'info',
      message: `无需进一步合并：${blocks.length} 个网段互不重叠且不能继续合并`,
    });
  }

  return {
    inputs: [...rawInputs],
    blocks,
    totalAddresses: rangesTotalSize(before).toString(),
    inputCount: rawInputs.length,
    dedupCount,
    notes,
  };
}

export interface BlockRange {
  start: bigint;
  end: bigint;
}

export function blocksToRanges(blocks: CidrOut[]): BlockRange[] {
  return blocks.map((b) => ({ start: parseIpv4(b.start), end: parseIpv4(b.end) }));
}

export interface SetSnapshot {
  blocks: CidrOut[];
  totalAddresses: string;
}

function snapshotToRanges(snapshot: SetSnapshot): CidrBlock[] {
  return snapshot.blocks.map((b) => ({ start: parseIpv4(b.start), end: parseIpv4(b.end) }));
}

export interface ComputeResult {
  operation: 'intersection' | 'difference';
  leftSet: string;
  leftVersion: number;
  rightSet?: string;
  rightVersion?: number;
  blocks: CidrOut[];
  totalAddresses: string;
  notes: string[];
}

/** 两个已保存集合的交集。 */
export function intersectSets(
  leftName: string,
  leftVersion: number,
  left: SetSnapshot,
  rightName: string,
  rightVersion: number,
  right: SetSnapshot,
): ComputeResult {
  const ranges = intersectRanges(snapshotToRanges(left), snapshotToRanges(right));
  const merged = mergeRanges(ranges);
  return {
    operation: 'intersection',
    leftSet: leftName,
    leftVersion,
    rightSet: rightName,
    rightVersion,
    blocks: rangesToBlocks(merged),
    totalAddresses: rangesTotalSize(merged).toString(),
    notes: [
      `交集取两个集合共同覆盖的地址；集合 "${leftName}"@${leftVersion} 共 ${left.totalAddresses} 个地址，"${rightName}"@${rightVersion} 共 ${right.totalAddresses} 个地址`,
      merged.length === 0 ? '两集合无重叠，交集为空' : `命中 ${merged.length} 个连续区间`,
    ],
  };
}

/** 左集合减右集合：结果一定是左集合子集，不可能扩大。 */
export function subtractSets(
  leftName: string,
  leftVersion: number,
  left: SetSnapshot,
  rightName: string,
  rightVersion: number,
  right: SetSnapshot,
): ComputeResult {
  const leftRanges = snapshotToRanges(left);
  const ranges = subtractRanges(leftRanges, snapshotToRanges(right));
  const removed = BigInt(left.totalAddresses) - rangesTotalSize(ranges);
  return {
    operation: 'difference',
    leftSet: leftName,
    leftVersion,
    rightSet: rightName,
    rightVersion,
    blocks: rangesToBlocks(ranges),
    totalAddresses: rangesTotalSize(ranges).toString(),
    notes: [
      `从 "${leftName}"@${leftVersion} 中排除 "${rightName}"@${rightVersion} 覆盖的地址`,
      `移除 ${removed.toString()} 个地址，剩余 ${rangesTotalSize(ranges).toString()} 个；差集不会超出原集合`,
      ranges.length === 0 ? '全部地址已被删除，结果为空集合' : '相邻但不对齐的块保持拆分，不强行合并',
    ],
  };
}

export type MembershipStatus = 'member' | 'excluded' | 'never_seen';

export interface MembershipResult {
  address: string;
  status: MembershipStatus;
  matchedBlock?: string;
  message: string;
}

/**
 * 单地址归属查询：
 * - member：在最新版命名集合中
 * - excluded：曾在旧版本出现，但在最新版本中被移除（保留/排除语义）
 * - never_seen：任何版本都未出现
 */
export function queryMembership(
  addressText: string,
  latest: SetSnapshot,
  history: SetSnapshot[],
): MembershipResult {
  const ip = parseIpv4(addressText);
  const address = formatIpv4(ip);
  const latestRanges = snapshotToRanges(latest);
  if (containsIp(latestRanges, ip)) {
    const match = latest.blocks.find((b) => ip >= parseIpv4(b.start) && ip <= parseIpv4(b.end));
    return {
      address,
      status: 'member',
      matchedBlock: match?.cidr,
      message: `地址 ${address} 属于当前集合${match ? `，命中网段 ${match.cidr}` : ''}`,
    };
  }
  const ever = history.some((snapshot) => containsIp(snapshotToRanges(snapshot), ip));
  if (ever) {
    return {
      address,
      status: 'excluded',
      message: `地址 ${address} 曾出现在旧版本中，但已从当前集合排除`,
    };
  }
  return {
    address,
    status: 'never_seen',
    message: `地址 ${address} 从未出现在该集合的任何版本`,
  };
}

export { rangeSize };
