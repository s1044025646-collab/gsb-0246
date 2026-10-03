import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CidrError, CidrOut } from '../core/ip.js';
import {
  ComputeResult,
  MembershipResult,
  NormalizeResult,
  blocksToRanges,
  intersectSets,
  queryMembership,
  subtractSets,
} from '../core/normalize.js';

export interface SetVersion {
  id: number;
  setName: string;
  version: number;
  rawInputs: string[];
  result: NormalizeResult;
  createdAt: string;
}

export interface ReportRecord {
  id: number;
  operation: string;
  params: Record<string, unknown>;
  result: unknown;
  createdAt: string;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  raw_inputs TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  params_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(INIT_SQL);
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      if ((error as Error).message !== 'database is not open') throw error;
    }
  }

  /** 导入或追加一个新版本。非法输入抛错，整个事务回滚，不留任何成功记录。 */
  importSet(name: string, result: NormalizeResult): SetVersion {
    assertName(name);
    let versionRow: { version: number } | undefined;
    this.db.exec('BEGIN');
    try {
      versionRow = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM sets WHERE name = ?')
        .get(name) as { version: number };
      const version = versionRow.version + 1;
      this.db
        .prepare(
          `INSERT INTO sets (name, version, raw_inputs, result_json) VALUES (?, ?, ?, ?)`,
        )
        .run(name, version, JSON.stringify(result.inputs), JSON.stringify(result));
      this.db
        .prepare(
          `INSERT INTO reports (operation, params_json, result_json) VALUES (?, ?, ?)`,
        )
        .run(
          'import',
          JSON.stringify({ name, version }),
          JSON.stringify({ name, version, result }),
        );
      this.db.exec('COMMIT');
      return {
        id: 0,
        setName: name,
        version,
        rawInputs: result.inputs,
        result,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getVersion(name: string, version?: number): SetVersion {
    assertName(name);
    const row = version
      ? (this.db
          .prepare('SELECT * FROM sets WHERE name = ? AND version = ?')
          .get(name, version) as SetRow | undefined)
      : (this.db
          .prepare('SELECT * FROM sets WHERE name = ? ORDER BY version DESC LIMIT 1')
          .get(name) as SetRow | undefined);
    if (!row) {
      throw new CidrError(
        'SET_NOT_FOUND',
        version ? `集合 "${name}" 的版本 ${version} 不存在` : `集合 "${name}" 不存在`,
      );
    }
    return rowToVersion(row);
  }

  listVersions(name: string): SetVersion[] {
    assertName(name);
    const rows = this.db
      .prepare('SELECT * FROM sets WHERE name = ? ORDER BY version ASC')
      .all(name) as unknown as SetRow[];
    return (rows as unknown as SetRow[]).map(rowToVersion);
  }

  listSets(): { name: string; latestVersion: number; totalAddresses: string; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT s.name AS name, s.version AS version, s.result_json AS result_json, s.created_at AS created_at
         FROM sets s
         JOIN (SELECT name, MAX(version) AS mv FROM sets GROUP BY name) m
           ON m.name = s.name AND m.mv = s.version
         ORDER BY s.name ASC`,
      )
      .all() as { name: string; version: number; result_json: string; created_at: string }[];
    return rows.map((row) => {
      const result = JSON.parse(row.result_json) as NormalizeResult;
      return {
        name: row.name,
        latestVersion: row.version,
        totalAddresses: result.totalAddresses,
        createdAt: row.created_at,
      };
    });
  }

  private saveReport(operation: string, params: unknown, result: unknown): ReportRecord {
    const info = this.db
      .prepare('INSERT INTO reports (operation, params_json, result_json) VALUES (?, ?, ?)')
      .run(operation, JSON.stringify(params), JSON.stringify(result));
    return {
      id: Number(info.lastInsertRowid),
      operation,
      params: params as Record<string, unknown>,
      result,
      createdAt: new Date().toISOString(),
    };
  }

  compute(
    operation: 'intersection' | 'difference',
    leftName: string,
    rightName: string,
    leftVersion?: number,
    rightVersion?: number,
  ): { report: ReportRecord; result: ComputeResult } {
    const leftRow = this.getVersion(leftName, leftVersion);
    const rightRow = this.getVersion(rightName, rightVersion);
    const result =
      operation === 'intersection'
        ? intersectSets(
            leftName,
            leftRow.version,
            { blocks: leftRow.result.blocks, totalAddresses: leftRow.result.totalAddresses },
            rightName,
            rightRow.version,
            { blocks: rightRow.result.blocks, totalAddresses: rightRow.result.totalAddresses },
          )
        : subtractSets(
            leftName,
            leftRow.version,
            { blocks: leftRow.result.blocks, totalAddresses: leftRow.result.totalAddresses },
            rightName,
            rightRow.version,
            { blocks: rightRow.result.blocks, totalAddresses: rightRow.result.totalAddresses },
          );
    const report = this.saveReport(
      operation,
      {
        leftSet: leftName,
        leftVersion: leftRow.version,
        rightSet: rightName,
        rightVersion: rightRow.version,
      },
      result,
    );
    return { report, result };
  }

  membership(name: string, address: string, version?: number): MembershipResult {
    const latest = this.getVersion(name, version);
    const history = this.listVersions(name).map((v) => ({
      blocks: v.result.blocks,
      totalAddresses: v.result.totalAddresses,
    }));
    return queryMembership(
      address,
      { blocks: latest.result.blocks, totalAddresses: latest.result.totalAddresses },
      history,
    );
  }

  getReport(id: number): ReportRecord {
    const row = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as
      | ReportRow
      | undefined;
    if (!row) throw new CidrError('REPORT_NOT_FOUND', `报告 ${id} 不存在`);
    return {
      id: row.id,
      operation: row.operation,
      params: JSON.parse(row.params_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }

  listReports(): ReportRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM reports ORDER BY id ASC')
      .all() as unknown as ReportRow[];
    return rows.map((row) => ({
      id: row.id,
      operation: row.operation,
      params: JSON.parse(row.params_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    }));
  }
}

interface SetRow {
  id: number;
  name: string;
  version: number;
  raw_inputs: string;
  result_json: string;
  created_at: string;
}

interface ReportRow {
  id: number;
  operation: string;
  params_json: string;
  result_json: string;
  created_at: string;
}

function rowToVersion(row: SetRow): SetVersion {
  const result = JSON.parse(row.result_json) as NormalizeResult;
  return {
    id: row.id,
    setName: row.name,
    version: row.version,
    rawInputs: JSON.parse(row.raw_inputs),
    result,
    createdAt: row.created_at,
  };
}

function assertName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new CidrError('INVALID_NAME', '集合名称不能为空');
  }
  if (name.length > 64 || !/^[\w.\-\u4e00-\u9fa5]+$/.test(name)) {
    throw new CidrError('INVALID_NAME', '集合名称仅允许字母、数字、下划线、点、连字符与中文');
  }
}

export type { CidrOut };
export { blocksToRanges };
