import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CidrError } from "./ipv4";

export interface SetVersionRow {
  id: number;
  set_name: string;
  version: number;
  items: string[];
  normalized: unknown;
  total: number;
  created_at: string;
}

export interface ReportRow {
  id: number;
  op: string;
  params: unknown;
  result: unknown;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "cidr.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS set_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        items TEXT NOT NULL,
        normalized TEXT NOT NULL,
        total INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(set_name, version)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        params TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 保存新版本；同一名字的版本号递增。返回版本号。 */
  saveVersion(name: string, items: string[], normalized: unknown, total: number): number {
    if (!name || typeof name !== "string") {
      throw new CidrError("INVALID_NAME", "集合名称不能为空");
    }
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM set_versions WHERE set_name = ?")
      .get(name) as { v: number | null };
    const version = (row.v ?? 0) + 1;
    this.db
      .prepare(
        "INSERT INTO set_versions (set_name, version, items, normalized, total, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(name, version, JSON.stringify(items), JSON.stringify(normalized), total, new Date().toISOString());
    return version;
  }

  getVersion(name: string, version?: number): SetVersionRow {
    let row: unknown;
    if (version === undefined) {
      row = this.db
        .prepare("SELECT * FROM set_versions WHERE set_name = ? ORDER BY version DESC LIMIT 1")
        .get(name);
    } else {
      row = this.db
        .prepare("SELECT * FROM set_versions WHERE set_name = ? AND version = ?")
        .get(name, version);
    }
    if (!row) {
      throw new CidrError(
        version === undefined ? "SET_NOT_FOUND" : "VERSION_NOT_FOUND",
        version === undefined ? `集合不存在: "${name}"` : `集合 "${name}" 没有版本 ${version}`
      );
    }
    const r = row as Record<string, unknown>;
    return {
      id: r.id as number,
      set_name: r.set_name as string,
      version: r.version as number,
      items: JSON.parse(r.items as string) as string[],
      normalized: JSON.parse(r.normalized as string),
      total: r.total as number,
      created_at: r.created_at as string,
    };
  }

  listSets(): Array<{ name: string; versions: number; latest_total: number }> {
    const rows = this.db
      .prepare(
        `SELECT set_name AS name, COUNT(*) AS versions, MAX(version) AS latest
         FROM set_versions GROUP BY set_name ORDER BY set_name`
      )
      .all() as Array<{ name: string; versions: number; latest: number }>;
    return rows.map((r) => {
      const v = this.getVersion(r.name, r.latest);
      return { name: r.name, versions: r.versions, latest_total: v.total };
    });
  }

  listVersions(name: string): Array<{ version: number; total: number; created_at: string }> {
    const rows = this.db
      .prepare("SELECT version, total, created_at FROM set_versions WHERE set_name = ? ORDER BY version")
      .all(name) as Array<{ version: number; total: number; created_at: string }>;
    if (rows.length === 0) throw new CidrError("SET_NOT_FOUND", `集合不存在: "${name}"`);
    return rows;
  }

  saveReport(op: string, params: unknown, result: unknown): number {
    const stmt = this.db.prepare(
      "INSERT INTO reports (op, params, result, created_at) VALUES (?, ?, ?, ?)"
    );
    const info = stmt.run(op, JSON.stringify(params), JSON.stringify(result), new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  getReport(id: number): ReportRow {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CidrError("REPORT_NOT_FOUND", `报告不存在: ${id}`);
    return {
      id: row.id as number,
      op: row.op as string,
      params: JSON.parse(row.params as string),
      result: JSON.parse(row.result as string),
      created_at: row.created_at as string,
    };
  }

  listReports(): Array<{ id: number; op: string; created_at: string }> {
    return this.db
      .prepare("SELECT id, op, created_at FROM reports ORDER BY id")
      .all() as Array<{ id: number; op: string; created_at: string }>;
  }
}
