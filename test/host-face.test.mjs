/**
 * dsh-session-trash —— 宿主面契约测试（node test/host-face.test.mjs）。
 *
 * 只读：对真实 sessions 根做一次 preview，并校验 SRC 注册的两个硬前提：
 *   ① 实例上的 typertRemote 绑定形状（网关 collectSrcClaims 认领依据）；
 *   ② 原型上的方法标记 + 4 个原型方法（网关按 Function#toString 解析形参名，
 *      所以形参必须是简单标识符 —— 这里顺带断言形参清单）。
 * 传入 DSH_SESSIONS_ROOT / DSH_SESSION_ID 时才做真实探测，否则只跑离线契约。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteFace, createTrashPorts, backupRootOf, sessionsRootOf } from "../host/index.js";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error("断言失败 #" + checks + "：" + message);
}

const DESCRIPTOR_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";
const METHODS = ["preview", "deleteSessions", "listBatches", "undoDelete"];

function stubCtx(extra) {
  const provided = {};
  return {
    provided,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => {
      const out = typeof fn === "function" ? fn() : null;
      return typeof out === "function" ? out : () => {};
    },
    reflect: {
      provide(name, value) {
        provided[name] = value;
        return () => delete provided[name];
      },
    },
    emit: (event) => { (extra && extra.events ? extra.events : []).push(event); },
    ...extra,
  };
}

async function testPathHelpers() {
  const ctx = stubCtx();
  ok(typeof sessionsRootOf(ctx, {}) === "string" && sessionsRootOf(ctx, {}).length > 0, "sessionsRoot 可解析");
  const explicit = sessionsRootOf(ctx, { sessionsRoot: "X:\\custom" });
  ok(explicit === "X:\\custom", "显式配置优先于推断");
  const root = sessionsRootOf(ctx, {});
  const backup = backupRootOf({}, root);
  ok(backup.indexOf("trash-backup") > 0, "备份根落在 sessions 的上级：" + backup);
  ok(backupRootOf({ backupRoot: "Y:\\bk" }, root) === "Y:\\bk", "显式备份根优先");
}

async function testSrcContract() {
  const base = await mkdtemp(join(tmpdir(), "trash-face-"));
  const ports = createTrashPorts(stubCtx(), { sessionsRoot: join(base, "sessions"), backupRoot: join(base, "bk") });
  const face = createRemoteFace(ports);

  const binding = face.typertRemote;
  ok(binding && typeof binding === "object", "实例带 typertRemote 绑定");
  ok(binding.service === face, "binding.service === 实例（readBinding 校验点 1）");
  ok(binding.serviceKey === "trash", "binding.serviceKey === trash（校验点 2）");
  ok(binding.namespace === "trash", "binding.namespace === trash（校验点 3）");
  ok(Object.isFrozen(binding), "绑定是冻结对象（协议要求）");

  const marker = Object.getPrototypeOf(face)[DESCRIPTOR_KEY];
  ok(marker && marker.version === 1, "原型带版本化方法标记");
  ok(marker.methods.length === METHODS.length, "标记声明 " + METHODS.length + " 个方法");
  ok(marker.methods.every((m) => m.invocation && m.invocation.kind === "direct"), "全部 direct 调用");

  for (const name of METHODS) {
    ok(typeof face[name] === "function", "原型方法存在：" + name);
    const source = Function.prototype.toString.call(Object.getPrototypeOf(face)[name]);
    const open = source.indexOf("(");
    const close = source.indexOf(")", open + 1);
    const params = source.slice(open + 1, close).trim().split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    for (const param of params) {
      ok(/^[$A-Z_a-z][$\w]*$/.test(param), name + " 的形参必须是简单标识符（网关按源码解析）：" + param);
    }
    ok(params.indexOf("signal") === -1 || params.indexOf("signal") === params.length - 1, name + " 若有 signal 必须在最后");
  }
  ok(Function.prototype.toString.call(Object.getPrototypeOf(face).preview).indexOf("(ids)") >= 0, "preview 形参名是 ids");
  ok(Function.prototype.toString.call(Object.getPrototypeOf(face).undoDelete).indexOf("(batch, ids)") >= 0, "undoDelete 形参名是 batch, ids");

  await rm(base, { recursive: true, force: true });
}

async function testEnvelopeResults() {
  const base = await mkdtemp(join(tmpdir(), "trash-face-"));
  const ports = createTrashPorts(stubCtx(), { sessionsRoot: join(base, "sessions"), backupRoot: join(base, "bk") });
  const face = createRemoteFace(ports);
  const empty = await face.preview([]);
  ok(empty.ok === false && /没有要删除的会话/.test(empty.error), "空入参走 {ok:false,error} 信封：" + empty.error);
  const list = await face.listBatches();
  ok(list.ok === true && Array.isArray(list.value), "listBatches 返回信封");
  const bad = await face.undoDelete("../escape", []);
  ok(bad.ok === false && /批次名不合法|不在预期/.test(bad.error), "越界批次名被拒：" + bad.error);
  await rm(base, { recursive: true, force: true });
}

async function testRealPreview() {
  const root = process.env.DSH_SESSIONS_ROOT;
  const id = process.env.DSH_SESSION_ID;
  if (!root || !id) {
    console.log("  （跳过真实 preview：未设置 DSH_SESSIONS_ROOT / DSH_SESSION_ID）");
    return;
  }
  const base = await mkdtemp(join(tmpdir(), "trash-face-real-"));
  const events = [];
  const ctx = stubCtx({ events });
  const ports = createTrashPorts(ctx, { sessionsRoot: root, backupRoot: join(base, "bk") });
  const face = createRemoteFace(ports);
  const preview = await face.preview([id]);
  ok(preview.ok === true, "真实 preview 成功：" + (preview.error || ""));
  const row = preview.value.results[0];
  ok(row.logDir !== null, "按 id 扫到日志目录：" + row.logDir);
  ok(row.logBytes > 0, "日志体积 " + row.logBytes + " 字节");
  ok(row.removed.indexOf("log") >= 0 || row.removed.indexOf("log(absent)") >= 0, "预览列出日志项：" + row.removed.join(","));
  ok(row.removed.indexOf("workspace-accounting") >= 0, "预览列出记账项");
  // dry-run 绝不能广播
  ok(events.length === 0, "preview 不广播任何移除事件");
  await rm(base, { recursive: true, force: true });
}

async function main() {
  await testPathHelpers();
  await testSrcContract();
  await testEnvelopeResults();
  await testRealPreview();
  console.log("host-face.test.mjs 通过：" + checks + " 项断言");
}

main().catch((error) => {
  console.error("FAIL:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
