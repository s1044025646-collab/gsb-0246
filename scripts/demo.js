// 演示脚本：两个相邻 /25 合成 /24，从 /24 排除一个地址，再与另一网段求交。
// 运行前需先 npm run build。使用独立的演示数据目录 ./data-demo。
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const cli = path.join(__dirname, "..", "dist", "src", "cli.js");
const dataDir = path.join(__dirname, "..", "data-demo");
fs.rmSync(dataDir, { recursive: true, force: true });
const env = { ...process.env, CIDR_DATA_DIR: dataDir };

function run(args) {
  const out = execFileSync(process.execPath, [cli.startsWith("--")?cli:"--disable-warning=ExperimentalWarning", cli, ...args], { env, encoding: "utf8" });
  return JSON.parse(out);
}

function show(title, obj) {
  console.log("=== " + title + " ===");
  console.log("CIDR 清单:", JSON.stringify(obj.cidrs));
  console.log("地址总数:", obj.total);
  if (obj.notes && obj.notes.length) console.log("说明:", obj.notes.join("；"));
  console.log();
}

console.log("步骤 1: 导入两个相邻 /25\n");
const v = run(["import", "office", "10.0.0.0/25", "10.0.0.128/25"]);
show("office 导入后归并", v);

console.log("步骤 2: 导入要排除的单个地址 10.0.0.5\n");
run(["import", "block", "10.0.0.5"]);

console.log("步骤 3: office - block（从 /24 中排除一个地址）\n");
const diff = run(["subtract", "office", "block"]);
show("差集结果（报告 " + diff.reportId + "）", diff);

console.log("步骤 4: 差集结果与 10.0.0.64/26 求交\n");
run(["import", "diffset", ...diff.cidrs]);
run(["import", "subnet", "10.0.0.64/26"]);
const inter2 = run(["intersect", "diffset", "subnet"]);
show("交集结果（报告 " + inter2.reportId + "）", inter2);

console.log("步骤 5: 归属查询（针对差集报告）\n");
for (const ip of ["10.0.0.1", "10.0.0.5", "10.0.1.1"]) {
  const m = run(["member", "report:" + diff.reportId, ip]);
  console.log(`  ${ip} -> ${m.status}`);
}
console.log();

console.log("步骤 6: 导出差集报告\n");
execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "export", String(diff.reportId), "report-demo.json"], {
  env, encoding: "utf8", stdio: "inherit",
});
console.log("演示完成。数据目录: data-demo，导出文件: report-demo.json");



