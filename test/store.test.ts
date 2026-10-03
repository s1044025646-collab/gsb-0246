import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { afterEach, beforeEach } from 'node:test';
import { CidrError } from '../dist/core/ip.js';
import { normalizeInputs } from '../dist/core/normalize.js';
import { Store } from '../dist/db/store.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cidr-test-'));
  store = new Store(join(dir, 'test.sqlite'));
});

afterEach(() => {
  store.close();
});

test('保存命名集合与版本，读取完整结果', () => {
  const saved = store.importSet('office', normalizeInputs(['10.0.0.0/25', '10.0.0.128/25']));
  assert.equal(saved.version, 1);
  assert.equal(saved.result.totalAddresses, '256');
  const again = store.importSet('office', normalizeInputs(['192.168.0.0/30']));
  assert.equal(again.version, 2);
  const old = store.getVersion('office', 1);
  assert.deepEqual(old.result.blocks.map((b) => b.cidr), ['10.0.0.0/24']);
});

test('非法输入不留下成功记录', () => {
  assert.throws(() => store.importSet('bad', normalizeInputs(['10.0.0.0/40'])), CidrError);
  assert.deepEqual(store.listSets(), []);
  assert.deepEqual(store.listReports(), []);
});

test('修改源集合不改变旧差集报告', () => {
  store.importSet('a', normalizeInputs(['10.0.0.0/24']));
  store.importSet('b', normalizeInputs(['10.0.0.5/32']));
  const { report } = store.compute('difference', 'a', 'b');
  const before = JSON.stringify(store.getReport(report.id));
  // 新建 b 的新版本（扩大排除范围）
  store.importSet('b', normalizeInputs(['10.0.0.0/25']));
  const after = JSON.stringify(store.getReport(report.id));
  assert.equal(before, after);
  assert.equal(JSON.parse(after).result.totalAddresses, '255');
});

test('成员查询 member / excluded / never_seen', () => {
  store.importSet('s', normalizeInputs(['10.0.0.0/24']));
  store.importSet('s', normalizeInputs(['10.0.0.128/25']));
  assert.equal(store.membership('s', '10.0.0.200').status, 'member');
  assert.equal(store.membership('s', '10.0.0.1').status, 'excluded');
  assert.equal(store.membership('s', '8.8.8.8').status, 'never_seen');
});

test('差集不扩大原集合：总数不超过左集合', () => {
  store.importSet('x', normalizeInputs(['10.0.0.0/24']));
  store.importSet('y', normalizeInputs(['10.0.0.0/30']));
  const { result } = store.compute('difference', 'x', 'y');
  assert.equal(result.totalAddresses, '252');
});

test('服务重启（重新打开同一数据库）后读取同一报告', () => {
  const saved = store.importSet('z', normalizeInputs(['0.0.0.0/32', '255.255.255.255/32']));
  store.close();
  const reopened = new Store(join(dir, 'test.sqlite'));
  const loaded = reopened.getVersion('z', saved.version);
  assert.equal(loaded.result.totalAddresses, '2');
  const reports = reopened.listReports();
  assert.equal(reports.length, 1);
  reopened.close();
});
