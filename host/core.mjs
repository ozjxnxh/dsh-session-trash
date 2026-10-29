/**
 * dsh-session-trash —— 删除会话的核心实现（宿主侧，纯逻辑 + 明确副作用清单）。
 *
 * 口径（用户 2026-10-29 明确要求）：不是从列表里挪走，而是把这条会话的聊天记录本身删掉；
 * 项目产物（工作区目录与其中的文件）一律不动 —— 本文件里没有任何指向工作区路径的写操作。
 *
 * 一条会话在 DSH 里的「聊天数据」由四处构成（逐包核实于 app.asar 0.2.1-alpha.2）：
 *   1. 会话日志      <home>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/
 *   2. 投影缓存      session_projcache 域 sessions 表的 <encodeSegment(id)> 记录
 *   3. 工作区记账    workspace 域：sessionIds 槽位 + archived / pinned 集合
 *   4. 定时提醒      schedule 域 tasks 表中 sessionId 命中的行
 * 附件存储（objects/<2 位>/<sha256>）是内容寻址、跨会话共享的，删它会伤到别的会话，故不碰。
 *
 * 真删前把日志整档搬进备份区并写 manifest.json，因此「删除」可撤销。
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 会话 id 的单段路径编码（与 dsh-session-persistence-jsonl 的 encodeSegment 逐字符一致）。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 项目目录名（同包 projectKey 的复刻：分隔符折叠为 -，非安全码点 ~XXXX，截断 251）。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return "--" + (readable.replace(/^-+/, "") || "root").slice(0, 251) + "--";
}

/** 一条会话的日志目录（cwd 缺失时后端落在 _no-cwd）。 */
export function sessionLogDir(sessionsRoot, cwd, id) {
  const project = typeof cwd === "string" && cwd.length > 0 ? projectKey(cwd) : "_no-cwd";
  return join(sessionsRoot, project, encodeSegment(id));
}

/** encodeSegment 的逆（撤销与展示用）。 */
export function decodeSegment(encoded) {
  return encoded.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** 路径必须严格落在 root 之内（绝不对任意路径动手）。 */
export function assertInside(root, target, label) {
  const norm = (s) => String(s).replace(/[\\/]+$/g, "").toLowerCase();
  const r = norm(root);
  const t = norm(target);
  /* 根自身也拒绝：目标必须严格更深一层，否则一次解析错误就可能把整个 sessions 树端掉。 */
  const inside = t !== r && (t.startsWith(r + "\\") || t.startsWith(r + "/"));
  if (!inside) throw new Error((label || "目标路径") + " 不在预期根目录内，已中止：" + target);
  return target;
}

async function copyTree(src, dest) {
  const info = await stat(src);
  if (info.isFile()) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return 1;
  }
  const entries = await readdir(src, { withFileTypes: true });
  if (entries.length === 0) { await mkdir(dest, { recursive: true }); return 0; }
  let n = 0;
  for (const e of entries) n += await copyTree(join(src, e.name), join(dest, e.name));
  return n;
}

/** 整档搬移：先 rename（同盘瞬时），失败再复制（跨盘）。 */
async function moveTree(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try { await rename(src, dest); return "moved"; }
  catch { await copyTree(src, dest); return "copied"; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 删除一批会话。逐条独立结算：一条失败不影响其它条。
 *
 * @param ports - {
 *    sessionsRoot, backupRoot, now(), log(level, msg),
 *    locate(id)            -> { cwd, title } | null   权威 header（可缺省，走文件系统兜底）
 *    holders(id)           -> string[]                该会话挂在哪些工作区（只读预览用）
 *    countSchedules(id)    -> number                  只读预览用
 *    hasProjection(id)     -> boolean                 只读预览用
 *    detachWorkspace(id)   -> Promise<void>           摘记账 + 取消置顶 + 移出归档
 *    deleteProjection(id)  -> Promise<boolean>
 *    deleteSchedules(id)   -> Promise<number>
 *    stopLive(id)          -> Promise<void>           停掉仍在跑的工作并落盘
 *  }
 * @param ids - 会话 id 列表
 * @param options - { dryRun }
 */
export async function deleteSessions(ports, ids, options = {}) {
  const dryRun = options.dryRun === true;
  const wanted = [...new Set((ids || []).filter((x) => typeof x === "string" && x.length > 0))];
  if (wanted.length === 0) return { results: [], dryRun, batch: null };
  const stamp = new Date(ports.now ? ports.now() : Date.now()).toISOString().replace(/[:.]/g, "-");
  const batchDir = join(ports.backupRoot, stamp);
  const results = [];
  const manifest = { stamp, createdAt: new Date().toISOString(), items: [] };

  for (const id of wanted) {
    const row = { id, ok: false, title: null, cwd: null, logDir: null, logBytes: 0, backup: null, removed: [], skipped: [], errors: [] };
    results.push(row);
    try {
      // ---- 定位（两种模式都只做只读探测）----
      const info = ports.locate ? await ports.locate(id) : null;
      row.cwd = info && typeof info.cwd === "string" ? info.cwd : null;
      row.title = info && typeof info.title === "string" ? info.title : null;
      let dir = sessionLogDir(ports.sessionsRoot, row.cwd, id);
      if (!await pathExists(dir)) {
        const found = await sweepFor(ports.sessionsRoot, id);
        if (found) dir = found;
      }
      const hasLog = await pathExists(dir);
      row.logDir = hasLog ? dir : null;
      if (hasLog) row.logBytes = await dirBytes(dir);
      row.removed.push(hasLog ? "log" : "log(absent)");
      if (ports.holders) {
        const holders = await ports.holders(id);
        if (holders && holders.length) row.removed.push("workspace-accounting:" + holders.length);
        else row.removed.push("workspace-accounting");
      } else row.removed.push("workspace-accounting");
      if (ports.countSchedules) {
        const n = await ports.countSchedules(id);
        if (n) row.removed.push("schedules:" + n);
      }
      if (ports.hasProjection && await ports.hasProjection(id)) row.removed.push("projection-cache");

      if (dryRun) { row.ok = true; continue; }

      // ---- 真删：先停活，再摘记账，最后搬走日志 ----
      if (ports.stopLive) { try { await ports.stopLive(id); } catch (e) { row.skipped.push("stop:" + errorMessage(e)); } }
      if (ports.detachWorkspace) { await ports.detachWorkspace(id); }
      if (ports.deleteSchedules) { await ports.deleteSchedules(id); }
      if (ports.deleteProjection) { await ports.deleteProjection(id); }

      if (hasLog) {
        assertInside(ports.sessionsRoot, dir, "会话日志目录");
        const dest = join(batchDir, encodeSegment(id));
        row.backupMode = await moveTree(dir, dest);
        row.backup = dest;
        const gone = await removeTree(dir, ports);
        if (!gone) {
          row.errors.push("日志目录仍被占用，未能删除（该会话可能正在运行，先停止它再删）：" + dir);
          // 已经把副本放进备份区了，回滚搬回去，避免同一份日志出现两处
          try { await rename(dest, dir); row.backup = null; } catch { /* 保留备份，交由批次清单 */ }
        } else {
          manifest.items.push({ id, cwd: row.cwd, title: row.title, from: dir, to: dest });
        }
      }
    } catch (error) {
      row.errors.push(errorMessage(error));
    }
    /* 单一出处：这一条真正清干净了才广播；dry-run 在上方已 continue，绝不会走到这里。 */
    if (row.errors.length === 0 && ports.announceRemoved) ports.announceRemoved(id);
    row.ok = row.errors.length === 0;
  }

  if (!dryRun && manifest.items.length > 0) {
    try {
      await mkdir(batchDir, { recursive: true });
      await writeJsonAtomic(join(batchDir, "manifest.json"), manifest);
    } catch (error) {
      for (const row of results) if (row.ok) row.errors.push("备份清单写入失败：" + errorMessage(error));
    }
  }
  /* 备份保留策略：删完顺手清最老的批次（失败不影响删除结果）。 */
  if (!dryRun && manifest.items.length > 0 && ports.prune) {
    try { await ports.prune(); } catch (error) { if (ports.log) ports.log("warn", "清理过期备份失败：" + errorMessage(error)); }
  }
  return { results, dryRun, batch: dryRun ? null : batchDir };
}

/** 删除目录树，对被占用的文件重试几次（Windows 上句柄释放有延迟）。 */
async function removeTree(dir, ports) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* 下面统一判定 */ }
    if (!await pathExists(dir)) return true;
    if (ports && ports.log) ports.log("warn", "日志目录尚未释放，重试：" + dir);
    await sleep(150 * (attempt + 1));
  }
  return !await pathExists(dir);
}

async function dirBytes(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      try { total += (await stat(join(dir, e.name))).size; } catch { /* 忽略单个文件 */ }
    }
    return total;
  } catch { return 0; }
}

/** 在 sessions 根目录里按 id 扫一遍（至多一层项目目录）。 */
async function sweepFor(sessionsRoot, id) {
  const seg = encodeSegment(id);
  let projects = [];
  try { projects = await readdir(sessionsRoot, { withFileTypes: true }); } catch { return null; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const candidate = join(sessionsRoot, p.name, seg);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function errorMessage(error) {
  if (!error) return String(error);
  return error.message ? String(error.message) : String(error);
}

async function writeJsonAtomic(path, value) {
  const tmp = path + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** 备份批次清单（撤销面板用），新→旧。 */
export async function listBatches(backupRoot) {
  let names = [];
  try { names = await readdir(backupRoot); } catch { return []; }
  const out = [];
  for (const name of names.sort().reverse()) {
    try {
      const manifest = JSON.parse(await readFile(join(backupRoot, name, "manifest.json"), "utf8"));
      out.push({
        batch: name,
        createdAt: manifest.createdAt || name,
        items: (manifest.items || []).map((item) => ({ id: item.id, title: item.title || null, cwd: item.cwd || null })),
      });
    } catch { /* 无清单的目录不是本插件的批次 */ }
  }
  return out;
}

/**
 * 撤销一次删除：把备份里的日志目录搬回原位，并重新登记到工作区。
 * @param ports - { sessionsRoot, backupRoot, locateWorkspace(cwd), attach(id, workspaceId) }
 * @param batch - 批次名（listBatches 的 batch 字段）
 * @param ids - 只恢复这些 id（缺省=整批）
 */
export async function undoDelete(ports, batch, ids) {
  if (!batch || batch.includes("/") || batch.includes("\\")) throw new Error("批次名不合法");
  const root = join(ports.backupRoot, batch);
  assertInside(ports.backupRoot, root, "备份批次");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const set = ids && ids.length ? new Set(ids) : null;
  const restored = [];
  const skipped = [];
  for (const item of manifest.items || []) {
    if (set && !set.has(item.id)) continue;
    const src = item.to;
    const dest = item.from;
    if (!await pathExists(src)) { skipped.push({ id: item.id, reason: "备份缺失" }); continue; }
    if (await pathExists(dest)) { skipped.push({ id: item.id, reason: "原位已存在同名会话日志" }); continue; }
    assertInside(ports.sessionsRoot, dest, "恢复目标");
    await mkdir(dirname(dest), { recursive: true });
    await rename(src, dest);
    if (ports.attach && item.cwd && ports.locateWorkspace) {
      const workspaceId = await ports.locateWorkspace(item.cwd);
      if (workspaceId) await ports.attach(item.id, workspaceId);
    }
    restored.push({ id: item.id, title: item.title || null, cwd: item.cwd || null });
  }
  if (restored.length > 0) {
    const left = (manifest.items || []).filter((item) => !restored.some((r) => r.id === item.id));
    try { await writeJsonAtomic(join(root, "manifest.json"), { ...manifest, items: left }); } catch { /* 清单残留不影响恢复结果 */ }
  }
  return { restored, skipped, batch };
}
