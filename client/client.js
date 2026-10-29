/**
 * dsh-session-trash —— 浏览器半边（官方插件客户端，无构建步骤：纯 JS + React.createElement）。
 *
 * 提供三块 UI：
 *   1. 侧栏会话「…」菜单里的「删除会话」（危险色 + 分隔线）—— 弹确认框，删掉这一条的聊天记录；
 *   2. 同一菜单里的「多选批量删除…」—— 弹出带复选框的列表，一次删多条；
 *   3. 确认框 + 删除完成提示条（含「撤销」，把备份搬回来）。两块浮层都挂在 shell.overlay。
 *
 * 设计取舍：
 *   · 删除动作走本插件自建的 Remote 面 `trash`（DSH 原生没有删除会话的 API）；
 *   · 不碰行内插槽做复选框 —— sidebar.session.row.leading 只在「空闲行」渲染
 *     （运行中/归档行会被状态点占位），做出来的多选会缺一块；集中式对话框对所有会话都有效；
 *   · 任何异常都不出组件：远端缺席时对话框显示可读错误，绝不让 web boot 失败。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-trash",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useMemo, useSyncExternalStore } = React;

    /* 原子组件来自 shell 静态模块表（web-frontend dist 的 staticModules 明确列有
     * react / @deepseek-ai/dsh-client-ui-primitives），不经过插件图。取不到就整套降级不渲染，
     * 插件条目仍然激活成功（启动绝不因本插件失败）。 */
    let P = null;
    try {
      P = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      P = null;
    }

    const PKG = "dsh-session-trash";
    const NS = "dsh-session-trash";
    const MENU_SLOT = "sidebar.workspaces.session.menu.item";
    const OVERLAY_SLOT = "shell.overlay";
    const REMOTE_NS = "trash";

    /* ─────────────── 词典（注册进宿主 locale，菜单行与对话框都用 t() 取词）─────────────── */
    const zh = {
      "menu.delete": "删除会话",
      "menu.multi": "多选批量删除…",
      "confirm.title": "删除会话",
      "confirm.titleMulti": "批量删除会话",
      "confirm.desc": "将彻底删除所选会话的聊天记录（对话内容、会话索引与定时提醒）。",
      "confirm.keep": "不会删除：工作区目录里的项目文件、上传附件。",
      "confirm.backup": "删除前会自动备份，完成后可用提示条里的「撤销」恢复。",
      "confirm.scope": "将删除",
      "confirm.noLog": "未找到日志（将只清理它在侧栏的记账）",
      "confirm.bytes": "日志 {size}",
      "confirm.schedules": "定时提醒 {n} 条",
      "confirm.projection": "会话索引",
      "confirm.accounting": "工作区记账",
      "confirm.expandChildren": "展开子代理",
      "confirm.collapseChildren": "收起子代理",
      "confirm.expandHint": "先选中主会话",
      "confirm.childrenCount": "{n} 个子代理",
      "confirm.childrenSummary": "含 {n} 个子代理会话",
      "confirm.subagentTag": "子代理",
      "confirm.picked": "已选 {n} 条会话",
      "confirm.selectAll": "全选",
      "confirm.clear": "清空",
      "confirm.filter": "搜索会话名称或目录…",
      "confirm.none": "没有可删除的会话",
      "confirm.empty": "侧栏里还没有会话",
      "confirm.deleting": "正在删除…",
      "confirm.action": "删除",
      "confirm.actionOne": "删除这条会话",
      "cancel": "取消",
      "close": "关闭",
      "toast.deleted": "已删除 {n} 个会话的聊天记录",
      "toast.undo": "撤销",
      "toast.restored": "已恢复 {n} 个会话",
      "toast.close": "关闭提示",
      "error.notReady": "删除服务未就绪，请重启 DSH 后重试",
    };
    const en = {
      "menu.delete": "Delete session",
      "menu.multi": "Delete multiple…",
      "confirm.title": "Delete session",
      "confirm.titleMulti": "Delete sessions",
      "confirm.desc": "Permanently deletes the chat history of the selected sessions (messages, index entries and reminders).",
      "confirm.keep": "Kept: project files in the workspace folder, uploaded attachments.",
      "confirm.backup": "A backup is taken first; use Undo in the toast to restore.",
      "confirm.scope": "Will delete",
      "confirm.noLog": "No log found (only the sidebar entry is cleared)",
      "confirm.bytes": "log {size}",
      "confirm.schedules": "{n} reminder(s)",
      "confirm.projection": "session index",
      "confirm.accounting": "workspace record",
      "confirm.expandChildren": "Expand subagents",
      "confirm.collapseChildren": "Collapse subagents",
      "confirm.expandHint": "Select the main session first",
      "confirm.childrenCount": "{n} subagent(s)",
      "confirm.childrenSummary": "includes {n} subagent session(s)",
      "confirm.subagentTag": "Subagent",
      "confirm.picked": "{n} session(s) selected",
      "confirm.selectAll": "Select all",
      "confirm.clear": "Clear",
      "confirm.filter": "Search title or folder…",
      "confirm.none": "No sessions selected",
      "confirm.empty": "No sessions yet",
      "confirm.deleting": "Deleting…",
      "confirm.action": "Delete",
      "confirm.actionOne": "Delete this session",
      "cancel": "Cancel",
      "close": "Close",
      "toast.deleted": "Deleted chat history of {n} session(s)",
      "toast.undo": "Undo",
      "toast.restored": "Restored {n} session(s)",
      "toast.close": "Dismiss",
      "error.notReady": "Delete service not ready — restart DSH and retry",
    };

    /* ─────────────── 模块级状态（浮层是常驻条目，只有它需要跨组件共享）─────────────── */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set: (next) => {
          state = typeof next === "function" ? next(state) : next;
          for (const fn of [...listeners]) {
            try { fn(); } catch (error) { /* 单个订阅者异常不影响其他 */ }
          }
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    }
    const dialogStore = createStore({ open: false, mode: "one", ids: [], busy: false, error: null, preview: null });
    const toastStore = createStore(null);
    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    /* ─────────────── Remote 面接线（$mount 异步，就绪前用子 fiber 等待）─────────────── */
    let MOD_CTX = null;
    let REMOTE_SVC = null;
    const MOUNT_DIAG = { attempted: false, ok: null, error: null };
    const JSON_ANY = Object.freeze({ parse: (value) => value });
    /* 形参名与宿主 face 的方法形参逐字一致（网关按源码形参名对齐 wire 字段）。 */
    const METHOD_TABLE = [
      ["preview", ["ids"]],
      ["deleteSessions", ["ids"]],
      ["listBatches", []],
      ["undoDelete", ["batch", "ids"]],
    ];
    const codec = (method, field) => ({
      mode: "strict",
      typeSymbol: PKG + "#trash/" + method + ":" + field,
      create: () => JSON_ANY,
    });
    const CONTRIBUTION = {
      package: PKG,
      descriptors: METHOD_TABLE.map(([method, params]) => ({
        id: PKG + "#trash/" + method,
        service: REMOTE_NS,
        namespace: REMOTE_NS,
        method,
        invocation: { kind: "direct" },
        parameters: params.map((name) => ({
          name,
          wire: name,
          source: "json",
          codec: codec(method, name),
        })),
        result: codec(method, "result"),
      })),
    };

    async function call(method, ...args) {
      const svc = REMOTE_SVC || (MOD_CTX && MOD_CTX.remote ? MOD_CTX.remote[REMOTE_NS] : null);
      if (!svc || typeof svc[method] !== "function") {
        const error = new Error("remote.trash 不可用（" + method + "）");
        error.code = "not-ready";
        throw error;
      }
      const raw = await svc[method](...args);
      if (raw && typeof raw === "object" && typeof raw.ok === "boolean" && "value" in raw) {
        if (raw.ok) return raw.value;
        const err = raw.error;
        const message = err && err.message ? String(err.message) : String(err == null ? "远程调用失败" : err);
        /* 宿主面没注册上（例如插件降级）时网关回 invocation-unavailable ——
         * 翻成本地化的"重启后重试"，别把英文网关原文甩给用户。 */
        if (message.indexOf("invocation-unavailable") >= 0 || message.indexOf("no active Remote method") >= 0) {
          const notReady = new Error(message);
          notReady.code = "not-ready";
          throw notReady;
        }
        throw new Error(message);
      }
      return raw;
    }
    const errorText = (error) => (error && error.message ? String(error.message) : String(error));

    /* ─────────────── 小工具 ─────────────── */
    function formatBytes(n) {
      const size = Number(n) || 0;
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(0) + " KB";
      return (size / 1024 / 1024).toFixed(1) + " MB";
    }
    function basenameOf(path) {
      if (typeof path !== "string" || path === "") return "";
      const trimmed = path.replace(/[\\/]+$/, "");
      const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      return at >= 0 ? trimmed.slice(at + 1) : trimmed;
    }
    function displayName(row, fallback) {
      const title = row && typeof row.displayTitle === "string" ? row.displayTitle.trim() : "";
      return title || fallback || "未命名会话";
    }
    const dateLabel = (ms) => {
      const value = Number(ms) || 0;
      if (!value) return "";
      try {
        return new Date(value).toLocaleString();
      } catch (error) {
        return "";
      }
    };

    /* Modal 只接受 className（不透传 style），宽度/滚动用一条带命名空间的样式解决。 */
    const DIALOG_STYLE = h("style", null,
      ".dsh-session-trash-dialog{width:min(560px,calc(100vw - 48px));max-width:calc(100vw - 32px);}",
      ".dsh-session-trash-dialog-content .dsh-session-trash-row:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);}"
    );

    /* @tree-logic:start ──────────────────────────────────────────────────
     * 主/子代理分层的**纯逻辑**（零依赖：不碰 React / 词典 / 远端）。
     * test/tree-logic.test.mjs 用这对标记把本块抽出来跑验收断言。
     *
     * 规则映射：
     *  1 默认收起 → expanded 初始为空，showChildren 只在显式展开时为真
     *  2 子代理不进主列表 → build().top 剔除子代理行（与 ui-workspace 的
     *    sessionVisible(origin === "subagent") 同源判定）
     *  3/5 选中主代理 → 连同其全部子代理（family / toggleFamily）
     *  4 展开收起按钮 → 展示态单独存 expanded，与选中态解耦
     *  6 仅主代理被选中时生效 → showChildren 的第一道闸就是"父行已选中"
     * ────────────────────────────────────────────────────────────────── */
    const Tree = {
      /**
       * 该行是不是子代理会话。**只认 origin === "subagent"，与侧栏 sessionVisible 完全同源**。
       *
       * 刻意不看 parentId：分叉会话（fork）同样带 parentSession 却没有 origin
       * （dsh-session 的 fork 只写 { parentSession, isSeeded }，真子代理在 dsh-subagent 里
       * 无条件写 origin: "subagent"）—— 按血缘判会把用户可见的分叉行一起藏掉，
       * 而侧栏是保留分叉的，两边口径必须一致。
       */
      isSubagent(row) {
        return !!row && typeof row === "object" && row.origin === "subagent";
      },
      /**
       * 把快照行分层。
       * @param entries 顶层候选 [{id, row}]（调用方已排除 blank 行）
       * @param byId 全量行表（含 ids 之外的、目录派生出来的子代理）
       * @returns {{ top, childrenOf, subIds }}
       */
      build(entries, byId) {
        const childrenOf = Object.create(null);
        /* 只有"非子代理行"才有资格当挂载点：子代理本身不进顶层（规则 2），
         * 挂在它名下的孙代理会跟着一起消失、再也删不掉。 */
        const parentSet = new Set(entries.filter((entry) => !this.isSubagent(entry.row)).map((entry) => entry.id));
        /* 把血缘一路上溯到最近的主会话（孙代理挂到主代理名下），带环/过深保护。 */
        const resolveRoot = (pid) => {
          let cursor = pid;
          for (let hop = 0; cursor && hop < 8; hop++) {
            const row = byId ? byId[cursor] : null;
            if (!row) return cursor;
            if (!this.isSubagent(row)) return cursor;
            if (typeof row.parentId !== "string" || row.parentId === "") return null;
            cursor = row.parentId;
          }
          return null;
        };
        const put = (pid, cid) => {
          const root = resolveRoot(pid);
          if (!root || root === cid || !parentSet.has(root)) return;
          if (!childrenOf[root]) childrenOf[root] = [];
          if (childrenOf[root].indexOf(cid) < 0) childrenOf[root].push(cid);
        };
        for (const entry of entries) {
          if (this.isSubagent(entry.row)) put(entry.row.parentId, entry.id);
        }
        if (byId && typeof byId === "object") {
          for (const id of Object.keys(byId)) {
            const row = byId[id];
            if (!row || row.blank || !this.isSubagent(row)) continue;
            put(row.parentId, id);
          }
        }
        const subIds = new Set();
        for (const key of Object.keys(childrenOf)) for (const cid of childrenOf[key]) subIds.add(cid);
        /* 顶层 = 主会话 + 没能挂上去的孤儿子代理（"挂上了谁"看 subIds，
         * 而不是看 row.parentId：孙代理是被改挂到主代理名下的，看 parentId 会误判成孤儿）。 */
        const top = entries.filter((entry) => !this.isSubagent(entry.row) || !subIds.has(entry.id));
        return { top, childrenOf, subIds };
      },
      /** 主会话入列时连带其全部子代理（规则 5：默认全选）。 */
      family(ids, childrenOf) {
        const out = ids.slice();
        for (const id of ids) {
          const kids = childrenOf[id];
          if (!kids) continue;
          for (const cid of kids) if (out.indexOf(cid) < 0) out.push(cid);
        }
        return out;
      },
      /** 勾/取消一个主会话：选中时连子代理一起选，取消时连子代理一起清（规则 3/6）。 */
      toggleFamily(picked, id, childrenOf) {
        const kids = childrenOf[id] || [];
        const wasPicked = picked.indexOf(id) >= 0;
        let out = picked.filter((value) => value !== id && kids.indexOf(value) < 0);
        if (!wasPicked) out = out.concat([id]).concat(kids.filter((cid) => picked.indexOf(cid) < 0));
        return out;
      },
      /** 单独勾/取消一个子代理（仅在父行选中且已展开时可点）。 */
      toggleChild(picked, id) {
        return picked.indexOf(id) >= 0 ? picked.filter((value) => value !== id) : picked.concat([id]);
      },
      /** 该父行的子代理是否已全部选中（徽标用）。 */
      allChildrenPicked(picked, childrenOf, id) {
        const kids = childrenOf[id] || [];
        return kids.length === 0 || kids.every((cid) => picked.indexOf(cid) >= 0);
      },
      /** 展示闸门（规则 6 / 验收 1）：父行未选中一律不展示子代理。 */
      showChildren(picked, expanded, id, hasQuery) {
        if (picked.indexOf(id) < 0) return false;
        return !!hasQuery || expanded.indexOf(id) >= 0;
      },
      /** 过滤命中：标题或工作目录包含检索词。 */
      matches(row, needle) {
        if (!needle) return true;
        if (!row || typeof row !== "object") return false;
        const title = String(row.displayTitle || row.title || "").toLowerCase();
        const cwd = typeof row.cwd === "string" ? row.cwd.toLowerCase() : "";
        return title.indexOf(needle) >= 0 || cwd.indexOf(needle) >= 0;
      },
    };
    /* @tree-logic:end */

    /* ─────────────── 确认对话框（单条 + 多选共用一个组件）─────────────── */
    function DeleteDialog({ t, sessionsList }) {
      const state = useStore(dialogStore);
      const [query, setQuery] = useState("");
      const [picked, setPicked] = useState([]);
      const [preview, setPreview] = useState(null);
      const [previewError, setPreviewError] = useState(null);
      /* 规则 1/4：展开态独立存一份，默认空 = 全部收起；与选中态解耦。 */
      const [expanded, setExpanded] = useState([]);
      /* 远端缺席走词典（call() 会带 code:"not-ready"），其余原样显示宿主消息。 */
      const messageOf = (error) => (error && error.code === "not-ready" ? t("error.notReady") : errorText(error));

      const snapshot = useMemo(() => {
        try {
          return sessionsList.getSnapshot();
        } catch (error) {
          return null;
        }
      }, [sessionsList, state.open, state.mode]);

      const rows = useMemo(() => {
        if (!snapshot) return [];
        const list = [];
        for (const id of snapshot.ids || []) {
          const row = snapshot.byId ? snapshot.byId[id] : null;
          if (!row || row.blank) continue;
          list.push({ id, row });
        }
        list.sort((a, b) => (Number(b.row.updatedAt) || 0) - (Number(a.row.updatedAt) || 0));
        return list;
      }, [snapshot]);

      /* 规则 2：top = 只剩主会话（子代理被分到 childrenOf，或作为孤儿退回顶层）。 */
      const tree = useMemo(
        () => (snapshot ? Tree.build(rows, snapshot.byId) : { top: rows, childrenOf: Object.create(null), subIds: new Set() }),
        [rows, snapshot]
      );

      /* 打开时把「这次选择」播种进 picked，并取一次预览（只读）。 */
      useEffect(() => {
        if (!state.open) return undefined;
        setQuery("");
        setPreview(null);
        setPreviewError(null);
        setExpanded([]);
        const byId = snapshot ? snapshot.byId : null;
        const built = Tree.build(rows, byId);
        if (state.mode === "one") {
          /* 单条删除：主会话连同其全部子代理一起入列（规则 5），并在"将删除"里汇总展示。 */
          const first = state.ids.slice(0, 1)[0];
          setPicked(first ? Tree.family([first], built.childrenOf) : []);
        } else {
          /* 多选：入口只给主会话；子代理由父行带入（规则 3/5），自身不进主列表（规则 2）。 */
          const raw = state.ids && state.ids.length ? state.ids : built.top.map((entry) => entry.id);
          const source = raw.filter((id) => !Tree.isSubagent(byId ? byId[id] : null));
          setPicked(Tree.family(source, built.childrenOf));
        }
        return undefined;
      }, [state.open, state.mode, state.ids.join("\u0000")]);

      /* 预览：选中集变化后 250ms 取一次（本地文件系统探测，量小）。 */
      useEffect(() => {
        if (!state.open || picked.length === 0) {
          setPreview(null);
          return undefined;
        }
        let alive = true;
        const timer = setTimeout(() => {
          call("preview", picked.slice()).then(
            (value) => {
              if (alive) {
                setPreview(value);
                setPreviewError(null);
              }
            },
            (error) => {
              if (alive) setPreviewError(messageOf(error));
            }
          );
        }, 250);
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [state.open, picked.join("\u0000")]);

      if (!P || !state.open) return null;

      const hasQuery = query.trim() !== "";
      const needle = query.trim().toLowerCase();
      const visible = tree.top.filter((entry) => {
        if (!hasQuery) return true;
        if (Tree.matches(entry.row, needle)) return true;
        /* 搜到子代理 → 连父行一起显示（子行随后按选中态决定是否展开）。 */
        const kids = tree.childrenOf[entry.id] || [];
        return kids.some((cid) => Tree.matches(snapshot ? snapshot.byId[cid] : null, needle));
      });

      /* 规则 3/6：主会话勾选=连子代理全选；取消=连子代理一起清，并顺手收起。 */
      const toggleTop = (id) => {
        setPicked((current) => Tree.toggleFamily(current, id, tree.childrenOf));
        setExpanded((current) => current.filter((value) => value !== id));
      };
      /* 规则 4：展开/收起只改展示态，不动选中态。 */
      const toggleExpand = (id) => {
        setExpanded((current) => (current.indexOf(id) >= 0 ? current.filter((value) => value !== id) : current.concat([id])));
      };
      /* 子代理单独调整（仅在父行选中并展开时可见可点）。 */
      const toggleChild = (id) => {
        setPicked((current) => Tree.toggleChild(current, id));
      };
      const close = () => {
        if (state.busy) return;
        dialogStore.set((current) => ({ ...current, open: false, busy: false, error: null }));
      };

      const proceed = () => {
        const ids = picked.slice();
        if (ids.length === 0) return;
        dialogStore.set((current) => ({ ...current, busy: true, error: null }));
        call("deleteSessions", ids).then(
          (report) => {
            const results = (report && report.results) || [];
            const okRows = results.filter((row) => row.ok);
            const failed = results.filter((row) => !row.ok);
            dialogStore.set((current) => ({ ...current, open: false, busy: false, error: null, ids: [] }));
            if (okRows.length > 0) {
              toastStore.set({
                kind: "deleted",
                n: okRows.length,
                batch: report && report.batch ? report.batch : null,
                failed: failed.map((row) => errorText({ message: row.errors && row.errors[0] ? row.errors[0] : "未知错误" })),
                seq: Date.now(),
              });
            }
            if (failed.length > 0 && okRows.length === 0) {
              dialogStore.set((current) => ({ ...current, open: true, busy: false, error: failed.map((row) => row.errors && row.errors[0] ? String(row.errors[0]) : "未知错误").join("；") }));
            }
            /* 双保险：宿主已广播 api-session/removed，这里再拉一次权威列表。 */
            const sessions = MOD_CTX && typeof MOD_CTX.get === "function" ? MOD_CTX.get("sessions") : null;
            if (sessions && typeof sessions.refresh === "function") {
              Promise.resolve(sessions.refresh()).catch(() => {});
            }
          },
          (error) => {
            dialogStore.set((current) => ({ ...current, busy: false, error: messageOf(error) }));
          }
        );
      };

      const previewRows = (preview && preview.results) || [];
      const previewById = {};
      for (const row of previewRows) previewById[row.id] = row;

      const scopeBy = snapshot ? snapshot.byId : null;
      const scopeList = [];
      for (const id of picked.slice(0, 60)) {
        /* 规则 2：子代理不逐条进"将删除"清单（多选列表同理），改由父行下方一行汇总。 */
        if (Tree.isSubagent(scopeBy ? scopeBy[id] : null)) continue;
        const row = previewById[id];
        if (!row) {
          scopeList.push({ id, label: displayName(rows.find((entry) => entry.id === id) ? rows.find((entry) => entry.id === id).row : null, id), detail: null, noLog: false });
          continue;
        }
        const detail = [];
        if (row.logBytes) detail.push(t("confirm.bytes", { size: formatBytes(row.logBytes) }));
        const removed = row.removed || [];
        for (const item of removed) {
          if (item.indexOf("schedules:") === 0) detail.push(t("confirm.schedules", { n: item.slice(10) }));
          else if (item.indexOf("projection-cache") === 0) detail.push(t("confirm.projection"));
          else if (item.indexOf("workspace-accounting") === 0) detail.push(t("confirm.accounting"));
        }
        scopeList.push({
          id,
          label: displayName({ displayTitle: row.title || "" }, displayName(rows.find((entry) => entry.id === id) ? rows.find((entry) => entry.id === id).row : null, id)),
          detail: detail.join(" · "),
          noLog: removed.indexOf("log(absent)") >= 0,
        });
      }
      const summaryCount = picked.filter((id) => Tree.isSubagent(scopeBy ? scopeBy[id] : null)).length;
      if (summaryCount > 0) {
        scopeList.push({ id: "__subagents", label: t("confirm.childrenSummary", { n: summaryCount }), detail: "", noLog: false, summary: true });
      }

      const footer = h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end", width: "100%" } },
        h(P.Button, { variant: "outline", disabled: state.busy, onClick: close }, t("cancel")),
        h(P.Button, {
          variant: "primary",
          disabled: state.busy || picked.length === 0,
          onClick: proceed,
          style: { background: "var(--dsw-alias-state-error-primary, var(--dsw-alias-brand-primary, currentColor))", borderColor: "transparent" },
        }, state.busy ? t("confirm.deleting") : (picked.length === 1 ? t("confirm.actionOne") : t("confirm.action") + " " + picked.length))
      );

      const body = state.mode === "one"
        ? h("div", null,
            h("div", { style: { marginBottom: "8px" } }, t("confirm.desc")),
            h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor))", marginBottom: "8px" } }, t("confirm.keep"), " ", t("confirm.backup")),
            previewError ? h("div", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, currentColor)", marginBottom: "6px" } }, previewError) : null,
            h("div", { style: { border: "1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, transparent))", borderRadius: "8px", padding: "8px 10px", fontSize: "12px", lineHeight: "18px" } },
              h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("confirm.scope")),
              scopeList.length === 0 ? h("div", null, "…") : scopeList.map((item) => h("div", {
                key: item.id,
                style: {
                  color: item.summary
                    ? "var(--dsw-alias-label-tertiary, currentColor)"
                    : "var(--dsw-alias-label-secondary, currentColor)",
                  paddingLeft: item.summary ? "10px" : undefined,
                },
              },
                (item.summary ? "└ " : "• ") + item.label + (item.noLog ? " — " + t("confirm.noLog") : ""),
                item.detail ? h("span", { style: { color: "var(--dsw-alias-label-tertiary, currentColor)" } }, "（" + item.detail + "）") : null
              ))
            )
          )
        : h("div", null,
            h("div", { style: { marginBottom: "8px" } }, t("confirm.desc"), " ", t("confirm.keep"), " ", t("confirm.backup")),
            previewError ? h("div", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, currentColor)", marginBottom: "6px" } }, previewError) : null,
            h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" } },
              h("span", { style: { flex: "1 1 auto", minWidth: "0", display: "block" } },
                h(P.Input, {
                  value: query,
                  placeholder: t("confirm.filter"),
                  "aria-label": t("confirm.filter"),
                  onChange: (event) => setQuery(event.target.value),
                })
              ),
              h(P.Button, {
                variant: "outline",
                size: "sm",
                onClick: () => { setPicked(Tree.family(visible.map((entry) => entry.id), tree.childrenOf)); },
              }, t("confirm.selectAll")),
              h(P.Button, { variant: "outline", size: "sm", onClick: () => { setPicked([]); setExpanded([]); } }, t("confirm.clear"))
            ),
            h("div", { style: { fontSize: "12px", marginBottom: "6px", color: "var(--dsw-alias-label-secondary, currentColor)" } }, t("confirm.picked", { n: picked.length })),
            h("div", {
              style: {
                maxHeight: "min(46vh, 360px)",
                overflowY: "auto",
                border: "1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, transparent))",
                borderRadius: "8px",
                padding: "4px 6px",
              },
            },
              visible.length === 0
                ? h("div", { style: { padding: "10px", color: "var(--dsw-alias-label-tertiary, currentColor)" } }, rows.length === 0 ? t("confirm.empty") : t("confirm.none"))
                : visible.map((entry) => {
                    const byId = snapshot ? snapshot.byId : null;
                    const previewRow = previewById[entry.id];
                    const selected = picked.indexOf(entry.id) >= 0;
                    const kids = (tree.childrenOf[entry.id] || []).filter((cid) => !hasQuery || Tree.matches(byId ? byId[cid] : null, needle));
                    const canShowKids = kids.length > 0;
                    /* 规则 1 + 6：默认收起；父行未选中时即使按过展开也不展示。 */
                    const showKids = canShowKids && Tree.showChildren(picked, expanded, entry.id, hasQuery);
                    const secondary = entry.row.cwd ? basenameOf(entry.row.cwd) : (dateLabel(entry.row.updatedAt));
                    const sizePart = previewRow && previewRow.logBytes
                      ? " · " + formatBytes(previewRow.logBytes)
                      : (previewRow && (previewRow.removed || []).indexOf("log(absent)") >= 0 ? " · " + t("confirm.noLog") : "");
                    const parentSub = secondary + sizePart + (canShowKids ? " · " + t("confirm.childrenCount", { n: kids.length }) : "");
                    const expandLabel = showKids ? t("confirm.collapseChildren") : t("confirm.expandChildren");
                    return h("div", {
                      key: entry.id,
                      style: { padding: "5px 6px", borderRadius: "6px" },
                    },
                      h("div", { style: { display: "flex", alignItems: "flex-start", gap: "2px" } },
                        h("div", { style: { flex: "1 1 auto", minWidth: "0" } },
                          h(P.Checkbox, {
                            checked: selected,
                            onChange: () => toggleTop(entry.id),
                            label: h(React.Fragment, null,
                              h("div", { style: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, displayName(entry.row, entry.id)),
                              h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, currentColor)" } }, parentSub)
                            ),
                          })
                        ),
                        /* 规则 4：展开/收起按钮；规则 6：主会话未选中时禁用。 */
                        canShowKids ? h("button", {
                          type: "button",
                          disabled: !selected,
                          "aria-expanded": showKids,
                          "aria-label": expandLabel,
                          title: selected ? expandLabel : t("confirm.expandHint"),
                          onClick: () => toggleExpand(entry.id),
                          style: {
                            flex: "none",
                            width: "24px",
                            height: "24px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: "none",
                            borderRadius: "6px",
                            background: "transparent",
                            color: selected ? "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, currentColor))" : "var(--dsw-alias-label-tertiary, currentColor)",
                            opacity: selected ? 1 : 0.45,
                            cursor: selected ? "pointer" : "not-allowed",
                            marginTop: "1px",
                          },
                        }, showKids ? h(P.IconChevronDownOutlineRegular, { size: 14 }) : h(P.IconChevronRightOutlineRegular, { size: 14 })) : null
                      ),
                      showKids ? h("div", { style: { marginTop: "2px", display: "flex", flexDirection: "column", gap: "2px" } },
                        kids.map((cid) => {
                          const child = byId ? byId[cid] : null;
                          if (!child) return null;
                          const childPreview = previewById[cid];
                          const childSub = [
                            child.cwd ? basenameOf(child.cwd) : (dateLabel(child.updatedAt)),
                            childPreview && childPreview.logBytes ? " · " + formatBytes(childPreview.logBytes) : "",
                          ].join("");
                          /* 规则 2 的细则：子代理只在父行展开后以缩进子行出现，绝不占顶层位置。 */
                          return h("div", { key: cid, style: { paddingLeft: "22px" } },
                            h(P.Checkbox, {
                              checked: picked.indexOf(cid) >= 0,
                              onChange: () => toggleChild(cid),
                              label: h(React.Fragment, null,
                                h("div", { style: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                                  h("span", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, currentColor)" } }, t("confirm.subagentTag") + " · "),
                                  displayName(child, cid)
                                ),
                                h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, currentColor)" } }, childSub)
                              ),
                            })
                          );
                        })
                      ) : null
                    );
                  })
            ),
            h("div", { style: { fontSize: "11px", marginTop: "6px", color: "var(--dsw-alias-label-tertiary, currentColor)" } }, t("confirm.backup"))
          );

      return h(P.Modal, {
        open: true,
        onClose: close,
        closeLabel: t("close"),
        title: state.mode === "one" ? t("confirm.title") : t("confirm.titleMulti"),
        description: "",
        className: "dsh-session-trash-dialog",
        contentClassName: "dsh-session-trash-dialog-content",
        footer,
      }, DIALOG_STYLE, body);
    }

    /* ─────────────── 删除完成提示条（带撤销）─────────────── */
    function ToastHost({ t }) {
      const toast = useStore(toastStore);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => toastStore.set(null), toast.kind === "restored" ? 6000 : 12000);
        return () => clearTimeout(timer);
      }, [toast && toast.seq]);
      if (!P || !toast) return null;
      const undo = () => {
        if (!toast.batch || busy) return;
        setBusy(true);
        call("undoDelete", toast.batch, []).then(
          (value) => {
            setBusy(false);
            const restored = (value && value.restored) || [];
            toastStore.set({ kind: "restored", n: restored.length, seq: Date.now(), batch: null });
            const sessions = MOD_CTX && typeof MOD_CTX.get === "function" ? MOD_CTX.get("sessions") : null;
            if (sessions && typeof sessions.refresh === "function") {
              Promise.resolve(sessions.refresh()).catch(() => {});
            }
          },
          (error) => {
            setBusy(false);
            setNote(error && error.code === "not-ready" ? t("error.notReady") : errorText(error));
          }
        );
      };
      const base = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;";
      const box = {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "10px 14px",
        borderRadius: "10px",
        background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, #222))",
        color: "var(--dsw-alias-label-primary, currentColor)",
        border: "1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, transparent))",
        boxShadow: "var(--dsw-shadow-lv3, 0 10px 28px rgba(0,0,0,.28))",
        fontSize: "13px",
        maxWidth: "min(640px, calc(100vw - 32px))",
        pointerEvents: "auto",
      };
      const message = toast.kind === "restored"
        ? t("toast.restored", { n: toast.n || 0 })
        : t("toast.deleted", { n: toast.n || 0 });
      return h("div", { role: "status", style: { ...base, pointerEvents: "none" } },
        h("div", { style: box },
          h("span", null, message),
          toast.failed && toast.failed.length ? h("span", { style: { color: "var(--dsw-alias-state-error-primary, currentColor)", fontSize: "12px" } }, "（" + toast.failed[0] + "）") : null,
          note ? h("span", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, currentColor)", fontSize: "12px" } }, note) : null,
          toast.kind === "deleted" && toast.batch
            ? h(P.Button, { variant: "outline", size: "sm", disabled: busy, onClick: undo }, t("toast.undo"))
            : null,
          h(P.Button, { variant: "ghost", size: "sm", "aria-label": t("toast.close"), onClick: () => toastStore.set(null) }, t("toast.close"))
        )
      );
    }

    function OverlayHost(props) {
      return h(React.Fragment, null,
        h(DeleteDialog, props),
        h(ToastHost, { t: props.t })
      );
    }

    /* ─────────────── 菜单行 ─────────────── */
    function openDialog(mode, ids) {
      dialogStore.set({ open: true, mode, ids: ids || [], busy: false, error: null, preview: null });
    }

    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState ? useMenuOpenState() : [false, () => {}];
      if (!P) return null;
      return h(P.MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: h(P.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          if (typeof setMenuOpen === "function") setMenuOpen(false);
          openDialog("one", [sessionId]);
        },
      }, t("menu.delete"));
    }

    function MultiDeleteMenuItem({ useMenuOpenState, sessionsList, t }) {
      const [, setMenuOpen] = useMenuOpenState ? useMenuOpenState() : [false, () => {}];
      if (!P) return null;
      return h(P.MenuItemButton, {
        icon: h(P.IconChecklistOutlineRegular, { size: 14 }),
        onSelect: () => {
          if (typeof setMenuOpen === "function") setMenuOpen(false);
          const ids = [];
          try {
            const snapshot = sessionsList.getSnapshot();
            for (const id of snapshot.ids || []) {
              const row = snapshot.byId ? snapshot.byId[id] : null;
              /* 规则 2：子代理不进主列表 —— 它们由父行选中时自动带入。 */
              if (row && !row.blank && !Tree.isSubagent(row)) ids.push(id);
            }
          } catch (error) {
            /* 列表读不到时对话框会显示空态，而不是崩 */
          }
          openDialog("many", ids);
        },
      }, t("menu.multi"));
    }

    /* ─────────────── 插件入口 ─────────────── */
    return {
      /* ⚠️ 只能声明服务级依赖；顶层绝不可声明 remote.trash（那是我们自己 $mount 出来的命名空间，
      *   声明它=等自己 → web boot pending 死锁）。命名空间就绪改由子 fiber 订阅。 */
      inject: ["slots", "locale", "remote", "typert", "sessions"],
      apply(ctx) {
        try {
          MOD_CTX = ctx;

          /* 词典：渲染器的 kit.t 取自注册时声明的 locale 命名空间。 */
          try {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-trash: dictionaries");
          } catch (error) {
            console.warn("[session-trash] 词典注册失败（菜单将显示 key）：", errorText(error));
          }

          /* 挂载自建远端面（第三方本地包不被构建期内联进 api-remotes，必须自挂）。 */
          try {
            const mount = ctx.remote ? ctx.remote.$mount : null;
            if (typeof mount === "function") {
              MOUNT_DIAG.attempted = true;
              const result = mount.call(ctx.remote, CONTRIBUTION);
              if (result && typeof result.then === "function") {
                result.then(
                  () => { MOUNT_DIAG.ok = true; },
                  (error) => { MOUNT_DIAG.ok = false; MOUNT_DIAG.error = errorText(error); }
                );
              } else {
                MOUNT_DIAG.ok = true;
              }
            }
          } catch (error) {
            MOUNT_DIAG.ok = false;
            MOUNT_DIAG.error = errorText(error);
            console.warn("[session-trash] $mount 失败：", MOUNT_DIAG.error);
          }

          /* 命名空间就绪即回调（缺席时该子 fiber 只 pending，不阻塞本条目激活）。 */
          try {
            if (typeof ctx.inject === "function") {
              ctx.inject(["remote." + REMOTE_NS], (scope) => {
                const svc = scope && scope.remote ? scope.remote[REMOTE_NS] : null;
                if (svc) REMOTE_SVC = svc;
                return () => {
                  if (REMOTE_SVC === svc) REMOTE_SVC = null;
                };
              });
            }
          } catch (error) {
            console.warn("[session-trash] 等待 remote.trash 失败：", errorText(error));
          }

          /* 菜单两行：slot 由 ui-workspace 声明；未声明时 inject 只是不回调（不报错、不阻塞）。 */
          try {
            ctx.slots.inject(MENU_SLOT, function* () {
              yield ctx.slots.register({
                name: MENU_SLOT,
                id: PKG + ".delete",
                order: 500,
                locale: NS,
                inject: () => ({ sessionsList: ctx.sessions.list }),
              }, DeleteSessionMenuItem);
              yield ctx.slots.register({
                name: MENU_SLOT,
                id: PKG + ".multi",
                order: 510,
                locale: NS,
                inject: () => ({ sessionsList: ctx.sessions.list }),
              }, MultiDeleteMenuItem);
            });
          } catch (error) {
            console.warn("[session-trash] 菜单注册失败：", errorText(error));
          }

          /* 浮层：确认框 + 提示条（声明于 dsh-client-ui-layout 的 root children）。 */
          try {
            ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
              name: OVERLAY_SLOT,
              id: PKG + ".overlay",
              locale: NS,
              inject: () => ({ sessionsList: ctx.sessions.list }),
            }, OverlayHost));
          } catch (error) {
            console.warn("[session-trash] 浮层注册失败：", errorText(error));
          }
        } catch (error) {
          /* 整个 apply 兜底：任何异常都不许冒泡，否则 web boot 直接失败。 */
          console.warn("[session-trash] apply 降级（不阻塞启动）：", errorText(error));
        }
      },
    };
  },
});
