import { Store } from "./store";
import {
  ComputeResult,
  intersectSets,
  membershipOf,
  normalizeSet,
  subtractSets,
} from "./setops";
import { CidrError } from "./ipv4";

export interface SetRef {
  set: string;
  version?: number;
}

export class Service {
  constructor(public store: Store) {}

  importSet(name: string, items: string[]) {
    const norm = normalizeSet(items);
    const version = this.store.saveVersion(name, items, norm, norm.total);
    return {
      set: name,
      version,
      normalized: norm.normalized,
      cidrs: norm.cidrs,
      total: norm.total,
      notes: norm.notes,
    };
  }

  private resolveItems(ref: SetRef): { items: string[]; version: number } {
    if (!ref || typeof ref.set !== "string") {
      throw new CidrError("INVALID_REF", "集合引用需要 { set, version? }");
    }
    const v = this.store.getVersion(ref.set, ref.version);
    return { items: v.items, version: v.version };
  }

  merge(ref: SetRef) {
    const { items, version } = this.resolveItems(ref);
    const result = normalizeSet(items);
    const reportId = this.store.saveReport(
      "merge",
      { set: ref.set, version },
      result
    );
    return { reportId, input: { set: ref.set, version }, ...this.publicResult(result) };
  }

  intersect(a: SetRef, b: SetRef) {
    const ra = this.resolveItems(a);
    const rb = this.resolveItems(b);
    const result = intersectSets(ra.items, rb.items);
    const input = {
      a: { set: a.set, version: ra.version },
      b: { set: b.set, version: rb.version },
    };
    const reportId = this.store.saveReport("intersect", input, result);
    return { reportId, input, ...this.publicResult(result) };
  }

  subtract(a: SetRef, b: SetRef) {
    const ra = this.resolveItems(a);
    const rb = this.resolveItems(b);
    const result = subtractSets(ra.items, rb.items);
    const input = {
      a: { set: a.set, version: ra.version },
      b: { set: b.set, version: rb.version },
    };
    const reportId = this.store.saveReport("subtract", input, result);
    return { reportId, input, ...this.publicResult(result) };
  }

  membership(ip: string, ref: SetRef) {
    const { items, version } = this.resolveItems(ref);
    const result = normalizeSet(items);
    const status = membershipOf(ip, items, result.cidrs);
    return { ip, set: ref.set, version, status };
  }

  membershipByReport(ip: string, reportId: number) {
    const report = this.store.getReport(reportId);
    const params = report.params as { a?: { set: string; version: number }; set?: string; version?: number };
    const result = report.result as ComputeResult;
    let rawItems: string[];
    if (report.op === "subtract" && params.a) {
      rawItems = this.store.getVersion(params.a.set, params.a.version).items;
    } else if (params.set) {
      rawItems = this.store.getVersion(params.set, params.version).items;
    } else {
      throw new CidrError("INVALID_REPORT", "该报告类型不支持归属查询");
    }
    const status = membershipOf(ip, rawItems, result.cidrs ?? []);
    return { ip, reportId, status };
  }

  private publicResult(r: ComputeResult & { normalized?: unknown }) {
    return {
      normalized: r.normalized,
      cidrs: r.cidrs,
      // total 最大 2^32，JSON 数字精确表示
      total: r.total,
      notes: r.notes,
    };
  }
}
