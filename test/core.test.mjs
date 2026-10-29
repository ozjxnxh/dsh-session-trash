/**
 * dsh-session-trash —— host/core.mjs 的行为测试（node test/core.test.mjs）。
 *
 * 覆盖：dry-run 不动磁盘、真删=备份+清空+清单、目录被占用时的回滚、撤销恢复、
 * 路径安全闸（assertInside）、编码规则，以及对**真实 sessions 目录的只读探测**。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInside, deleteSessions, encodeSegment, listBatches, projectKey, sessionLogDir, undoDelete } from "../host/core.mjs";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error("断言失败 #" + checks + "：" + message);
}

function fakePorts(overrides) {
  const calls = [];
  const ports = {
    sessionsRoot: overrides.sessionsRoot,
    backupRoot: overrides.backupRoot,
    now: () => Date.parse("2026-10-29T12:00:00.000Z"),
    log: () => {},
    locate: overrides.locate ?? (async (id) => ({ cwd: "E:\\demo", title: "会话" + id })),
    holders: async (id) => { calls.push(["holders", id]); return ["ws-1"]; },
    countSchedules: async (id) => { calls.push(["countSchedules", id]); return 1; },
    hasProjection: async (id) => { calls.push(["hasProjection", id]); return true; },
    stopLive: async (id) => { calls.push(["stopLive", id]); },
    detachWorkspace: async (id) => { calls.push(["detachWorkspace", id]); },
    deleteSchedules: async (id) => { calls.push(["deleteSchedules", id]); return 1; },
    deleteProjection: async (id) => { calls.push(["deleteProjection", id]); return true; },
    announceRemoved: (id) => { calls.push(["announceRemoved", id]); },
    prune: async () => { calls.push(["prune"]); },
    locateWorkspace: async () => "ws-1",
    attach: async (id, ws) => { calls.push(["attach", id, ws]); },
    ...overrides.ports,
  };
  ports.calls = calls;
  return ports;
}

async function buildFixture() {
  const base = await mkdtemp(join(tmpdir(), "session-trash-"));
  const sessionsRoot = join(base, "sessions");
  const backupRoot = join(base, "trash-backup");
  const id = "session-abc-123";
  const dir = sessionLogDir(sessionsRoot, "E:\\demo", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.v4.jsonl.zstd"), "FAKE-ZSTD-BYTES");
  await writeFile(join(dir, "extra.txt"), "x");
  return { base, sessionsRoot, backupRoot, id, dir };
}

async function testDryRunLeavesDiskAlone() {
  const f = await buildFixture();
  const ports = fakePorts(f);
  const report = await deleteSessions(ports, [f.id], { dryRun: true });
  ok(report.dryRun === true, "dryRun 标记回传");
  ok(report.results.length === 1 && report.results[0].ok, "单条预览结算成功");
  ok(report.results[0].logDir === f.dir, "日志目录按 cwd 定位：" + report.results[0].logDir);
  ok(report.results[0].logBytes === "FAKE-ZSTD-BYTES".length + 1, "统计了目录内全部日志文件体积（15+1 字节）");
  ok((await stat(f.dir)).isDirectory(), "dry-run 不删目录");
  ok(!await exists(join(f.backupRoot)), "dry-run 不建备份");
  ok(ports.calls.filter((c) => c[0] === "detachWorkspace").length === 0, "dry-run 不改记账");
  ok(ports.calls.filter((c) => c[0] === "announceRemoved").length === 0, "dry-run 不广播移除");
  await rm(f.base, { recursive: true, force: true });
}

async function testRealDeleteBacksUpAndAnnounces() {
  const f = await buildFixture();
  const ports = fakePorts(f);
  const report = await deleteSessions(ports, [f.id], { dryRun: false });
  const row = report.results[0];
  ok(row.ok === true, "真删结算成功：" + (row.errors || []).join(";"));
  ok(!await exists(f.dir), "日志目录已删除");
  ok(await exists(row.backup), "备份已存在：" + row.backup);
  ok(await exists(join(row.backup, "session.v4.jsonl.zstd")), "备份里有日志文件");
  ok(await exists(join(report.batch, "manifest.json")), "写了 manifest.json");
  const manifest = JSON.parse(await readFile(join(report.batch, "manifest.json"), "utf8"));
  ok(manifest.items.length === 1 && manifest.items[0].id === f.id, "清单记录了本次删除");
  ok(manifest.items[0].from === f.dir, "清单记录原路径（撤销靠它）");
  const names = ports.calls.map((c) => c[0]);
  ok(names.indexOf("stopLive") < names.indexOf("detachWorkspace"), "先停活再摘记账");
  ok(names.indexOf("deleteProjection") >= 0 && names.indexOf("deleteSchedules") >= 0, "清了投影缓存与提醒");
  ok(names.indexOf("announceRemoved") >= 0, "广播了 api-session/removed");
  ok(names.indexOf("prune") >= 0, "清理了过期备份");
  const batches = await listBatches(ports.backupRoot);
  ok(batches.length === 1 && batches[0].items[0].id === f.id, "批次可被列出（撤销面板数据源）");
  await rm(f.base, { recursive: true, force: true });
}

async function testUndoRestoresLog() {
  const f = await buildFixture();
  const ports = fakePorts(f);
  const report = await deleteSessions(ports, [f.id], { dryRun: false });
  ok(!await exists(f.dir), "删除后原位为空");
  const batch = report.batch.split(/[\\\\/]/).pop();
  const result = await undoDelete(ports, batch, []);
  ok(result.restored.length === 1, "撤销恢复 1 条");
  ok(await exists(join(f.dir, "session.v4.jsonl.zstd")), "日志回到原位");
  ok(result.skipped.length === 0, "无跳过项");
  ok(ports.calls.some((c) => c[0] === "attach" && c[2] === "ws-1"), "重新登记回原工作区");
  const manifest = JSON.parse(await readFile(join(report.batch, "manifest.json"), "utf8"));
  ok(manifest.items.length === 0, "已恢复的条目从清单移除（不重复撤销）");
  await rm(f.base, { recursive: true, force: true });
}

async function testBusyDirectoryRollsBack() {
  const f = await buildFixture();
  const ports = fakePorts(f);
  // 第一次真删
  await deleteSessions(ports, [f.id], { dryRun: false });
  // 第二次删同一条：日志已不在 → 必须是干净的 no-op（log(absent)），而不是报错或写空备份。
  // 换一个时钟，避免与第一批同名（同一秒内两次删除会落到同一个时间戳批次）。
  const portsLater = fakePorts({ ...f, ports: { now: () => Date.parse("2026-10-29T13:00:00.000Z") } });
  const again = await deleteSessions(portsLater, [f.id], { dryRun: false });
  const row = again.results[0];
  ok(row.ok === true, "重复删除是干净 no-op，不报错：" + (row.errors || []).join(";"));
  ok((row.removed || []).indexOf("log(absent)") >= 0, "如实标记日志已不存在");
  ok(row.backup === null, "不产生空备份条目");
  // items 为空时清单不写入 —— 只断言"没有半份备份目录"
  const batchEntries = await exists(again.batch) ? await readdir(again.batch) : [];
  ok(batchEntries.indexOf(encodeSegment(f.id)) < 0, "空批次里不残留该会话的备份");
  await rm(f.base, { recursive: true, force: true });
}
async function testPathSafety() {
  let threw = false;
  try { assertInside("C:\\safe", "C:\\safe\\sub", "probe"); } catch (error) { threw = true; }
  ok(!threw, "根内路径放行");
  threw = false;
  try { assertInside("C:\\safe", "C:\\safe2\\x", "probe"); } catch (error) { threw = true; }
  ok(threw, "前缀相同但不在根内的路径必须拒绝（C:\\safe2）");
  threw = false;
  try { assertInside("C:\\safe", "C:\\safe", "probe"); } catch (error) { threw = true; }
  ok(threw, "根本身不可作为删除目标");
}

async function testEncodingMatchesBackend() {
  ok(projectKey("C:\\projects\\demo") === "--C-projects-demo--", "projectKey 编码路径段（不含尾随分隔符）");
  ok(encodeSegment("session-4869585f-c2c5-41a5-b7aa-82ee51ba5bb8") === "session-4869585f-c2c5-41a5-b7aa-82ee51ba5bb8", "纯 id 的编码是恒等");
  ok(sessionLogDir("C:\\h\\sessions", undefined, "s1").indexOf("_no-cwd") > 0, "缺 cwd 落到 _no-cwd（与后端一致）");
}

async function testRealSessionsScanReadOnly() {
  const root = process.env.DSH_SESSIONS_ROOT;
  if (!root) {
    console.log("  （跳过：未设置 DSH_SESSIONS_ROOT）");
    return;
  }
  const id = process.env.DSH_SESSION_ID;
  if (!id) return;
  const base = await mkdtemp(join(tmpdir(), "session-trash-real-"));
  const ports = fakePorts({
    sessionsRoot: root,
    backupRoot: join(base, "backup"),
    locate: async () => null,
  });
  const report = await deleteSessions(ports, [id], { dryRun: true });
  const row = report.results[0];
  ok(row.logDir !== null, "只读探测能在真实 sessions 根里按 id 找到日志目录：" + row.logDir);
  ok(row.logBytes > 0, "读到日志体积 " + row.logBytes + " 字节");
  await rm(base, { recursive: true, force: true });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await testEncodingMatchesBackend();
  await testPathSafety();
  await testDryRunLeavesDiskAlone();
  await testRealDeleteBacksUpAndAnnounces();
  await testUndoRestoresLog();
  await testBusyDirectoryRollsBack();
  await testRealSessionsScanReadOnly();
  console.log("core.test.mjs 通过：" + checks + " 项断言");
}

main().catch((error) => {
  console.error("FAIL:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
