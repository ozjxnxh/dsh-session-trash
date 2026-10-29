/**
 * dsh-session-trash —— 主/子代理分层展示与选中逻辑的验收测试。
 *
 * 直接从 client/client.js 的 @tree-logic 标记里抽出纯逻辑块来跑（保证测的就是线上那段），
 * 再对组件源码做两处静态断言（渲染闸门、入口过滤）。
 * 用法：node test/tree-logic.test.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "client", "client.js");
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error("断言失败 #" + checks + "：" + message);
}

const source = await readFile(clientPath, "utf8");

/* ── 抽取 @tree-logic 块 ── */
const startMark = "/* @tree-logic:start";
const endMark = "/* @tree-logic:end */";
const s = source.indexOf(startMark);
const e = source.indexOf(endMark);
ok(s >= 0 && e > s, "client.js 里必须有 @tree-logic 标记");
const declStart = source.indexOf("const Tree = ", s);
ok(declStart > s && declStart < e, "标记内必须有 const Tree =");
const block = source.slice(declStart, source.lastIndexOf(";", e));
const Tree = new Function(block + "; return Tree;")();
ok(typeof Tree.build === "function" && typeof Tree.showChildren === "function", "Tree 抽取成功");

/* ── fixture：模拟 sessions.list 快照里的一组行 ── */
const byId = {
  "main-a": { id: "main-a", displayTitle: "主会话 A", cwd: "E:\\demo\\app", updatedAt: 300 },
  "sub-a1": { id: "sub-a1", displayTitle: "子代理 1", origin: "subagent", parentId: "main-a", updatedAt: 290 },
  "sub-a2": { id: "sub-a2", displayTitle: "子代理 2", origin: "subagent", parentId: "main-a", updatedAt: 280 },
  /* 模拟 fork：有 parentSession 却没有 origin —— 侧栏保留它，本对话框也必须保留 */
  "fork-of-a": { id: "fork-of-a", displayTitle: "主会话 A 的分叉", parentId: "main-a", updatedAt: 270 },
  "main-b": { id: "main-b", displayTitle: "主会话 B", cwd: "E:\\demo\\other", updatedAt: 260 },
  "sub-orphan": { id: "sub-orphan", displayTitle: "孤儿子代理", origin: "subagent", parentId: "main-missing", updatedAt: 250 },
  "blank-x": { id: "blank-x", displayTitle: "新会话", blank: true, updatedAt: 240 },
  /* 委托深度 2：孙代理的父行是子代理，必须上溯挂到 main-a 名下，否则会从列表里消失 */
  "sub-grand": { id: "sub-grand", displayTitle: "孙代理", origin: "subagent", parentId: "sub-a1", updatedAt: 230 },
};
const entries = ["main-a", "sub-a1", "sub-a2", "fork-of-a", "main-b", "sub-orphan", "sub-grand", "blank-x"]
  .filter((id) => !byId[id].blank)
  .map((id) => ({ id, row: byId[id] }));

const tree = Tree.build(entries, byId);

/* 验收 3：子代理不出现在主列表 */
const topIds = tree.top.map((entry) => entry.id);
ok(topIds.indexOf("sub-a1") < 0 && topIds.indexOf("sub-a2") < 0, "子代理不出现在顶层主列表");
ok(topIds.indexOf("fork-of-a") >= 0, "分叉会话（有血缘无 origin）留在主列表，与侧栏口径一致");
ok(topIds.indexOf("main-a") >= 0 && topIds.indexOf("main-b") >= 0, "主会话都在主列表");
ok(topIds.indexOf("sub-orphan") >= 0, "父行不在列表的孤儿子代理退回顶层（否则永远删不到）");
ok(topIds.indexOf("blank-x") < 0, "空行仍被排除");

/* 规则 5 的数据基础：childrenOf 收齐了目录派生的子代理（byId 扫描，不受 ids 限制） */
const kids = tree.childrenOf["main-a"] || [];
ok(kids.indexOf("sub-a1") >= 0 && kids.indexOf("sub-a2") >= 0, "childrenOf 收齐常规子代理");
ok(kids.indexOf("fork-of-a") < 0, "分叉不被当成子代理挂到父行下");
ok(kids.indexOf("sub-orphan") < 0, "孤儿子代理不挂到任何父行下");
ok(kids.indexOf("sub-grand") >= 0, "孙代理上溯挂到主会话名下（不会从列表里消失）");
ok(topIds.indexOf("sub-grand") < 0, "孙代理同样不进主列表");
ok(Tree.isSubagent(byId["sub-a1"]) === true, "isSubagent 判定子代理");
ok(Tree.isSubagent(byId["main-a"]) === false, "isSubagent 不误判主会话");
ok(Tree.isSubagent(byId["fork-of-a"]) === false, "isSubagent 不误判分叉会话");

/* ── 验收 1：未选中主代理时，子代理不展开、不被选中 ── */
ok(!Tree.showChildren([], [], "main-a", false), "默认（未选中 + 未展开）不展示子代理");
ok(!Tree.showChildren([], ["main-a"], "main-a", false), "父行未选中时，即便记录过展开态也不展示");
ok(!Tree.showChildren([], ["main-a"], "main-a", true), "父行未选中时，检索态也不放行");
ok(Tree.family([], tree.childrenOf).length === 0, "未选中主会话 → 子代理不被选中");

/* ── 规则 1：默认收起 ──（展开态由组件 useState([]) 持有，此处验证闸门语义）*/
ok(!Tree.showChildren(["main-a"], [], "main-a", false), "父行已选中但没点展开 → 默认仍收起");

/* ── 规则 3/5 + 验收 2：选中主代理 → 子代理默认全选 ── */
const family = Tree.family(["main-a"], tree.childrenOf);
ok(family.indexOf("main-a") >= 0, "family 含父行");
ok(kids.every((cid) => family.indexOf(cid) >= 0), "family 含该主会话下的全部子代理（默认全选）");
const pickedAll = Tree.family(topIds, tree.childrenOf);
ok(pickedAll.length === topIds.length + kids.length, "全选 = 主列表全部 + 其子代理（全选按钮口径）");

/* 规则 3：勾父行=连子代理入列；取消=连子代理清空 */
const on = Tree.toggleFamily([], "main-a", tree.childrenOf);
ok(on.length === 1 + kids.length, "勾选主会话一次性带入全部子代理");
const off = Tree.toggleFamily(on, "main-a", tree.childrenOf);
ok(off.indexOf("main-a") < 0, "取消主会话后父行出列");
ok(kids.every((cid) => off.indexOf(cid) < 0), "取消主会话后子代理一并出列（不留孤儿选中）");

/* 规则 4：展开/收起只影响展示，不改选中态（两个状态各自独立） */
ok(Tree.showChildren(on, ["main-a"], "main-a", false) === true, "选中 + 展开 → 展示子代理（验收 2 后半句）");
ok(on.indexOf("sub-a1") >= 0, "展开这个动作不改变 picked 内容");

/* 规则 6：父行选中为前提 —— 子代理单独调一个不影响父行 */
const childOff = Tree.toggleChild(on, "sub-a1");
ok(childOff.indexOf("sub-a1") < 0 && childOff.indexOf("main-a") >= 0, "取消单个子代理不动父行");
ok(Tree.showChildren(childOff, ["main-a"], "main-a", false) === true, "父行仍选中 → 子代理仍可展开");
ok(Tree.allChildrenPicked(childOff, tree.childrenOf, "main-a") === false, "徽标能反映「子代理未全选」");
ok(Tree.allChildrenPicked(on, tree.childrenOf, "main-a") === true, "默认全选时徽标为真");

/* 检索 */
ok(Tree.matches(byId["sub-a1"], "子代理") === true, "子代理标题可被检索命中");
ok(Tree.matches(byId["main-a"], "app") === true, "工作目录可被检索命中");

/* ── 组件源码的两处静态断言（渲染闸门 / 入口过滤）── */
ok(source.indexOf("Tree.showChildren(picked, expanded") >= 0, "渲染处必须走 showChildren 闸门");
ok(source.indexOf("const [expanded, setExpanded] = useState([])") >= 0, "展开态默认为空数组（默认收起）");
ok(/Tree\.isSubagent\(row\)\) ids\.push/.test(source) || source.indexOf("ids.push(id)") > source.indexOf("Tree.isSubagent(row)"), "多选入口只播种非子代理行");
ok(source.indexOf("toggleTop(entry.id)") >= 0 && source.indexOf("toggleExpand(entry.id)") >= 0, "选中与展开是两个独立动作");

console.log("tree-logic.test.mjs 通过：" + checks + " 项断言");
