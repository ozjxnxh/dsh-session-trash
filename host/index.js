/**
 * dsh-session-trash —— 宿主半边。
 *
 * 把「删除会话（连聊天记录本体一起）」以 Remote 面 `trash` 暴露给浏览器端。
 * 远端面走 typertGateway 的 SRC 接收路径（服务实例带 typertRemote 绑定 + 原型方法标记），
 * 因此不声明 exports["./typert"]：加载器对没有该导出的包是静默跳过的，少一处会失败的环节。
 *
 * 删除范围只有聊天数据（日志 / 投影缓存 / 工作区记账 / 定时提醒）；工作区目录（项目产物）
 * 从不出现在任何写路径上。日志删除前先整档搬进备份区，可撤销。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deleteSessions as deleteSessionsCore, encodeSegment, listBatches as listBatchesCore, undoDelete as undoDeleteCore } from "./core.mjs";

const FACE_NAME = "trash";
/** 协议包 mark() 的落盘键（协议 README 声明该字符串跨安装副本稳定）。 */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
const REMOTE_METHODS = ["preview", "deleteSessions", "listBatches", "undoDelete"];

/** 会话日志根：显式配置 > 持久化后端的 root > DSH_HOME/sessions > ~/.dsh/sessions。 */
export function sessionsRootOf(ctx, config) {
  if (typeof config.sessionsRoot === "string" && config.sessionsRoot) return config.sessionsRoot;
  const backend = ctx.get("sessionPersistence");
  if (backend && typeof backend.root === "string" && backend.root) return backend.root;
  const env = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : "";
  const home = env || join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** 备份根：显式配置 > <sessions 的上级>/trash-backup。 */
export function backupRootOf(config, sessionsRoot) {
  if (typeof config.backupRoot === "string" && config.backupRoot) return config.backupRoot;
  return join(dirname(sessionsRoot), "trash-backup");
}

/** 只保留最近 N 个批次（默认 20；0 = 不清理）。 */
async function pruneBackups(backupRoot, keep, log) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const { readdir, rm, stat } = await import("node:fs/promises");
  let names = [];
  try { names = await readdir(backupRoot); } catch { return; }
  const stamped = [];
  for (const name of names) {
    try {
      const info = await stat(join(backupRoot, name));
      if (info.isDirectory()) stamped.push({ name, at: info.mtimeMs });
    } catch { /* 忽略读不到的条目 */ }
  }
  stamped.sort((a, b) => b.at - a.at);
  for (const item of stamped.slice(keep)) {
    try { await rm(join(backupRoot, item.name), { recursive: true, force: true }); }
    catch (error) { log("warn", "清理旧备份失败：" + messageOf(error)); }
  }
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

/**
 * 把 DSH 宿主服务翻译成 core.mjs 需要的端口。
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 已校验的插件配置。
 */
export function createTrashPorts(ctx, config) {
  const sessionsRoot = sessionsRootOf(ctx, config);
  const backupRoot = backupRootOf(config, sessionsRoot);
  const log = (level, message) => {
    try { ctx.logger[level]("session-trash: " + message); } catch { /* 无 logger 时静默 */ }
  };
  const persistence = () => ctx.get("sessionPersistence");
  const registry = () => ctx.get("workspaceRegistry");
  const domain = () => {
    const service = ctx.get("storageDomain");
    if (!service || typeof service.get !== "function") return null;
    return service.get("session_projcache") || null;
  };
  const schedule = () => ctx.get("schedule");
  const projcacheKey = (id) => encodeSegment(id);

  return {
    sessionsRoot,
    backupRoot,
    now: () => Date.now(),
    log,

    /** 权威 header：cwd 决定日志目录名，title 供确认弹窗显示。 */
    async locate(id) {
      const backend = persistence();
      if (!backend || typeof backend.stat !== "function") return null;
      try {
        const snapshot = await backend.stat(id);
        const header = snapshot && snapshot.header;
        if (!header) return null;
        return {
          cwd: typeof header.cwd === "string" ? header.cwd : null,
          title: typeof header.title === "string" ? header.title : null,
        };
      } catch (error) {
        log("info", "stat(" + id + ") 无记录：" + messageOf(error));
        return null;
      }
    },

    /** 只读：这条会话挂在哪些工作区（预览用）。 */
    async holders(id) {
      const host = registry();
      if (!host || typeof host.list !== "function") return [];
      try { return host.list().filter((w) => w.sessionIds.includes(id)).map((w) => w.id); }
      catch { return []; }
    },

    async hasProjection(id) {
      const opened = domain();
      if (!opened) return false;
      try { return opened.table("sessions").get(projcacheKey(id)) !== void 0; } catch { return false; }
    },

    async countSchedules(id) {
      const service = schedule();
      if (!service || typeof service.catalog !== "function") return 0;
      try { return (await service.catalog()).filter((t) => t && t.sessionId === id).length; }
      catch { return 0; }
    },

    /** 摘除工作区记账：取消置顶、移出归档集合、从各工作区 sessionIds 里去掉。 */
    async detachWorkspace(id) {
      const host = registry();
      if (!host) return;
      try { await host.unpinSession(id); } catch (error) { log("info", "unpin 跳过：" + messageOf(error)); }
      try { await host.unarchiveSession(id); } catch (error) { log("info", "unarchive 跳过：" + messageOf(error)); }
      for (const workspace of host.list()) {
        if (!workspace.sessionIds.includes(id)) continue;
        try { await workspace.detachSession(id); }
        catch (error) { log("warn", "detachSession 失败：" + messageOf(error)); }
      }
    },

    async deleteProjection(id) {
      const opened = domain();
      if (!opened) return false;
      try { return await opened.table("sessions").delete(projcacheKey(id)); }
      catch (error) { log("warn", "投影缓存删除失败：" + messageOf(error)); return false; }
    },

    async deleteSchedules(id) {
      const service = schedule();
      if (!service || typeof service.delete !== "function" || typeof service.catalog !== "function") return 0;
      let tasks = [];
      try { tasks = await service.catalog(); } catch (error) { log("warn", "读取提醒清单失败：" + messageOf(error)); return 0; }
      let n = 0;
      for (const task of tasks) {
        if (!task || task.sessionId !== id) continue;
        try {
          const result = await service.delete({ sessionId: id, id: task.id });
          if (result && result.deleted) n += 1;
        } catch (error) { log("warn", "提醒删除失败：" + messageOf(error)); }
      }
      return n;
    },

    /** 会话仍活着时先停掉它的工作并落盘（否则日志文件被占用，删不掉）。 */
    async stopLive(id) {
      const sessions = ctx.get("sessions");
      if (!sessions || typeof sessions.get !== "function") return;
      const live = sessions.get(id);
      if (live === void 0) return;
      try { await ctx.parallel("workspace/session-stop", { sessionId: id }); }
      catch (error) { log("info", "停止会话工作时部分提供方失败：" + messageOf(error)); }
      try { await sessions.flush(live); } catch { /* 落盘失败不阻断删除 */ }
      // 释放写入句柄：宿主没有公开的 dispose API，给内核一点时间回收
      await new Promise((resolve) => setTimeout(resolve, 120));
    },

    /** 撤销：找回原工作区并把会话重新登记回去。 */
    async locateWorkspace(cwd) {
      const host = registry();
      if (!host || typeof host.resolveByPath !== "function") return null;
      try { const w = await host.resolveByPath(cwd); return w ? w.id : null; } catch { return null; }
    },

    async attach(id, workspaceId) {
      const host = registry();
      const workspace = host && typeof host.get === "function" ? host.get(workspaceId) : void 0;
      if (!workspace) return;
      try { await workspace.attachSession(id); } catch (error) { log("warn", "恢复记账失败：" + messageOf(error)); }
    },

    /** 通知所有浏览器端这条会话已经没了（官方转发事件白名单里的键）。 */
    announceRemoved(id) {
      try { ctx.emit("api-session/removed", id); }
      catch (error) { log("warn", "移除通知失败：" + messageOf(error)); }
    },

    prune: () => pruneBackups(backupRoot, Number(config.keepBackups), log),
  };
}

/** 远端面（四个方法；形参一律简单标识符，网关 SRC 按源码形参名解析）。 */
export function createRemoteFace(ports) {
  const guard = async (run) => {
    try { return { ok: true, value: await run() }; }
    catch (error) { return { ok: false, error: messageOf(error) }; }
  };

  class TrashRemoteFace {
    constructor() {
      this.typertRemote = Object.freeze({ service: this, serviceKey: FACE_NAME, namespace: FACE_NAME });
    }

    /** 预览：这批会话会被删掉什么（不落盘、不改任何状态）。 */
    async preview(ids) {
      return guard(async () => {
        const list = normalizeIds(ids);
        if (list.length === 0) throw new Error("没有要删除的会话");
        return deleteSessionsCore(ports, list, { dryRun: true });
      });
    }

    /** 真删。逐条结算；成功条目随即通知前端。 */
    async deleteSessions(ids) {
      return guard(async () => {
        const list = normalizeIds(ids);
        if (list.length === 0) throw new Error("没有要删除的会话");
        /* 停活由 core 在逐条结算里统一做（单一出处）：这里再循环一遍等于每条多睡 120ms。 */
        /* 广播由 core 在每条真正删净后发出（单一出处，避免重复 emit）。 */
        const report = await deleteSessionsCore(ports, list, { dryRun: false });
        await ports.prune();
        return report;
      });
    }

    /** 备份批次清单（撤销面板）。 */
    async listBatches() {
      return guard(async () => listBatchesCore(ports.backupRoot));
    }

    /** 撤销一个批次（或批次里的部分会话）。 */
    async undoDelete(batch, ids) {
      return guard(async () => undoDeleteCore(ports, String(batch || ""), normalizeIds(ids)));
    }
  }

  Object.defineProperty(TrashRemoteFace.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: "direct" }),
      }))),
    }),
  });

  return new TrashRemoteFace();
}

function normalizeIds(ids) {
  if (Array.isArray(ids)) return ids.filter((x) => typeof x === "string" && x.length > 0);
  if (typeof ids === "string" && ids) return [ids];
  return [];
}

/** 只依赖必定存在的基础服务；任何异常都不冒泡（启动绝不因本插件失败）。 */
const inject = [];

/** Standard Schema v1（cordis 的 resolveConfig 只认 ~standard.validate）。 */
const Config = {
  "~standard": {
    version: 1,
    validate(value) {
      const input = value && typeof value === "object" ? value : {};
      const keep = Number(input.keepBackups);
      return {
        value: {
          sessionsRoot: typeof input.sessionsRoot === "string" ? input.sessionsRoot : "",
          backupRoot: typeof input.backupRoot === "string" ? input.backupRoot : "",
          keepBackups: Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 20,
        },
      };
    },
  },
};

/**
 * 插件入口。
 *
 * ⚠️ 配置是 **第二个参数**（cordis 把 `Config['~standard'].validate` 的结果直接传进来），
 * 不是 `ctx.config` —— 后者在未 inject 时会抛「cannot get property "config" without inject」，
 * 真机 13:23:09 的 warn 就是这么来的（导致 face 根本没注册上）。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 已校验的插件配置。
 */
function apply(ctx, config) {
  try {
    const resolved = config && typeof config === "object" ? config : {};
    const ports = createTrashPorts(ctx, resolved);
    const face = createRemoteFace(ports);
    const dispose = ctx.reflect && typeof ctx.reflect.provide === "function"
      ? ctx.reflect.provide(FACE_NAME, face)
      : (typeof ctx.provide === "function" ? ctx.provide(FACE_NAME, face) : null);
    if (typeof dispose === "function") ctx.effect(() => dispose);
    try { ctx.logger.info("session-trash 就绪（日志根：" + ports.sessionsRoot + "，备份：" + ports.backupRoot + "）"); } catch { /* 忽略 */ }
  } catch (error) {
    try { ctx.logger.warn("session-trash 启动降级：" + messageOf(error)); } catch { /* 忽略 */ }
  }
}

export { Config, apply, inject };
/** 插件显示名（日志/诊断用，同 dsh-dispatch 的 `export const name`）。 */
export const name = "dsh-session-trash";

