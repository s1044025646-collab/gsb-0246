import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { createServer } from "../src/api";
import { AddressInfo } from "node:net";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cidr-test-"));
}

test("导入、版本与计算报告持久化", () => {
  const dir = tmpDir();
  const service = new Service(new Store(dir));
  const v1 = service.importSet("base", ["10.0.0.0/25", "10.0.0.128/25"]);
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.cidrs, ["10.0.0.0/24"]);
  const v2 = service.importSet("base", ["10.0.0.0/24", "10.0.0.200"]);
  assert.equal(v2.version, 2);
  // 旧版本仍可读取，不受新版本影响
  const old = service.store.getVersion("base", 1);
  assert.deepEqual(old.items, ["10.0.0.0/25", "10.0.0.128/25"]);

  service.importSet("deny", ["10.0.0.5"]);
  const sub = service.subtract({ set: "base", version: 1 }, { set: "deny" });
  assert.equal(sub.total, 255);
  assert.equal(sub.input.a.version, 1);

  // 修改源集合后，旧报告不变
  service.importSet("deny", ["10.0.0.0/24"]);
  const report = service.store.getReport(sub.reportId);
  const result = report.result as { total: number };
  assert.equal(result.total, 255);

  // 归属查询：kept / excluded / never
  assert.equal(service.membershipByReport("10.0.0.1", sub.reportId).status, "kept");
  assert.equal(service.membershipByReport("10.0.0.5", sub.reportId).status, "excluded");
  assert.equal(service.membershipByReport("9.0.0.1", sub.reportId).status, "never");
  service.store.close();
});

test("错误输入不留下成功记录", () => {
  const dir = tmpDir();
  const service = new Service(new Store(dir));
  assert.throws(() => service.importSet("bad", ["10.0.0.0/33"]));
  assert.throws(() => service.importSet("bad", ["1.2.3"]));
  assert.deepEqual(service.store.listSets(), []);
  service.importSet("ok", ["10.0.0.0/24"]);
  assert.throws(() => service.subtract({ set: "ok" }, { set: "missing" }));
  assert.deepEqual(service.store.listReports(), []);
  service.store.close();
});

test("服务重启后读取同一报告", () => {
  const dir = tmpDir();
  let service = new Service(new Store(dir));
  service.importSet("a", ["172.16.0.0/24"]);
  service.importSet("b", ["172.16.0.128/25"]);
  const inter = service.intersect({ set: "a" }, { set: "b" });
  service.store.close();

  // 重新打开（模拟重启）
  service = new Service(new Store(dir));
  const report = service.store.getReport(inter.reportId);
  const result = report.result as { cidrs: string[]; total: number };
  assert.deepEqual(result.cidrs, ["172.16.0.128/25"]);
  assert.equal(result.total, 128);
  assert.equal(service.membership("172.16.0.200", { set: "b" }).status, "kept");
  service.store.close();
});

test("HTTP API 端到端", async () => {
  const dir = tmpDir();
  const service = new Service(new Store(dir));
  const server = createServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  let r = await post("/sets", { name: "net", items: ["192.168.1.0/25", "192.168.1.128/25"] });
  assert.equal(r.status, 201);
  assert.deepEqual((r.json as { cidrs: string[] }).cidrs, ["192.168.1.0/24"]);

  r = await post("/compute/merge", { set: "net" });
  assert.equal(r.status, 200);
  assert.equal((r.json as { total: number }).total, 256);

  r = await post("/compute/subtract", { a: { set: "net" }, b: { set: "nope" } });
  assert.equal(r.status, 400);
  assert.equal((r.json.error as { code: string }).code, "SET_NOT_FOUND");

  r = await post("/sets", { name: "bad", items: ["1.2.3.999"] });
  assert.equal(r.status, 400);
  assert.equal((r.json.error as { code: string }).code, "INVALID_IP");

  r = await post("/query/membership", { set: "net", ip: "192.168.1.7" });
  assert.equal((r.json as { status: string }).status, "kept");

  const reports = await get("/reports");
  assert.ok((reports.json.reports as unknown[]).length >= 1);
  const first = (reports.json.reports as Array<{ id: number }>)[0];
  const detail = await get(`/reports/${first.id}`);
  assert.equal(detail.status, 200);

  const notFound = await get("/nope");
  assert.equal(notFound.status, 404);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  service.store.close();
});
