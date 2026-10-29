# dsh-session-trash · 删除会话（含多选批量）

DSH 侧栏会话「…」菜单里新增两个入口，**把聊天记录本身删掉**（不是从列表里隐藏）：

- **删除会话**（危险色 + 分隔线）→ 弹确认框，删除这一条；
- **多选批量删除…** → 弹出带复选框的列表（可搜索、全选/清空），一次删多条。

删完右下角出提示条，可一键 **撤销**（把备份搬回来）。

## 删什么 / 不删什么

| 数据 | 处理 |
| --- | --- |
| 会话日志 `~/.dsh/sessions/<项目>/<会话id>/` | 删除（先整档搬进备份） |
| 投影缓存 `session_projcache` 记录 | 删除 |
| 工作区记账（`workspace` 域的 sessionIds / 置顶 / 归档） | 摘除 |
| 该会话的定时提醒（`schedule` 域） | 删除 |
| **工作区目录里的项目文件** | **不动** |
| 上传附件（内容寻址、跨会话共享） | 不动 |

> 备份默认在 `~/.dsh/trash-backup/<时间戳>/`（含 `manifest.json`），保留最近 20 批。
> 回收站里的备份也可以手工拷回。

## 安装（插件市场 / 收录后）

插件被 [awesome-dsh-plugin 目录](https://awesome-dsh-plugin.com) 收录后，可在 DSH 设置 → **插件市场** 一键安装；命令行等价形式：

```text
dsh plugin --profile web add github:YuJunZhiXue/dsh-session-trash
```

这条路径走 **bundle 层**（`package.json` 的 `dsh.bundle.patch` + 根目录 `cordis.patch.yml` 的 insert），loader 条目自动生效；**不要再**在 profile 层手工加同一条 insert，两条路径只留一条，否则会重复插入。

## 安装（本机 profile：desktop 手工方式）

1. 把本目录链接进 profile：
   `junction C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-session-trash <本目录>`
2. 在 profile 的 `cordis.patch.yml` 里加一条 insert：
   `- insert:` / `    - id: session-trash` / `      name: 'dsh-session-trash'`
3. 重启 DSH（客户端 bundle 与 loader 条目都在启动时组合）。

> 卸载：删掉 profile patch 里那条 insert + 删掉链接，重启即可。
> 若日后在 profile 目录里跑 `pnpm install`，pnpm 可能把未登记的链接当"外来物"清掉，
> 重新做上面第 1 步即可（或把本包以 `link:` 形式写进 dependencies 再装）。

## 结构

```
dsh-session-trash/
├── package.json        # dsh.bundle.patch + dsh.client 声明 + exports["./client"]
├── cordis.patch.yml    # bundle 层 insert（默认不启用，见文件头注释）
├── host/
│   ├── core.mjs        # 纯逻辑：定位/备份/删除/撤销 + 编码规则（可单测）
│   └── index.js        # Remote 面 `trash`（SRC 注册）+ 各宿主服务端口装配
├── client/client.js    # 菜单行 / 确认框 / 提示条（无构建，纯 JS + React.createElement）
└── icon.svg
```

## 为什么是插件

DSH 0.2.1-alpha.2 **没有**删除会话的 API（`dsh-session-persistence-jsonl` 的 README 明说
"seam 无删除接口，日志累积直到外部移除"）。所以本插件自建一个 Remote 面：

- 走 **typertGateway 的 SRC 接收路径**：服务实例带 `typertRemote` 绑定 + 原型方法标记，
  网关按 `Function#toString` 解析形参名 → 形参必须是简单标识符（不能默认值/解构）。
- 浏览器端 `ctx.remote.$mount({package, descriptors})` 自挂 `remote.trash`；
  **顶层 `inject` 绝不能写 `remote.trash`**（那是自己挂出来的命名空间，会 pending 死锁），
  改用子 fiber `ctx.inject(["remote.trash"], …)` 等就绪。
- 删除成功后广播 `api-session/removed`（官方转发事件白名单里的键），侧栏立即移除该行；
  工作区记账变化由 `domain/changed` 自动推给客户端；再补一次 `sessions.refresh()` 兜底。

## 已知限制

- **正在运行的会话**：删除前会先请求所有 `workspace/session-stop` 提供方停掉工作并落盘；
  若日志仍被占用会退避重试 6 次，仍失败则回滚备份并在对话框里报错（不半删）。
- **全文搜索索引**：默认配置是 `:memory:` + `openAt: never`（无磁盘残留）；若你启用了
  SQLite 索引，索引会在它自己的 reconcile 中跟上，重启后彻底重建。
- 归档行的「…」菜单同样有本入口（删除与归档互不影响）。

## 测试

```text
node test/core.test.mjs          # 删除/备份/撤销/路径安全/编码（36 断言）
node test/host-face.test.mjs     # Remote 面 SRC 契约 + 信封（29 断言）
  设 DSH_SESSIONS_ROOT / DSH_SESSION_ID 后再跑 = 对真实会话目录只读探测（35 断言）
node test/install-verify.cjs     # profile 安装校验：YAML / 链接 / bundle 路径 / 宿主导出（29 断言）
```

## 本机当前状态（2026-10-29 装好）

- 链接：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-trash` → 本目录（junction）
- profile patch：`...\profiles\desktop\cordis.patch.yml` 末尾的 `- id: session-trash` 一段
  （原文件已备份为 `cordis.patch.yml.bak-2026-10-29T13-23-07-549Z`）
- **需要重启 DSH 才生效**（loader 条目与客户端 bundle 都在启动时组合）。
## 真机日志里查到并修掉的两个坑（2026-10-29 13:23 实测）

把插件装进 profile 后，DSH 当场热加载并打印了两行 —— 这两行是**唯一可靠的验收证据**：

```text
warn  session-trash 启动降级：cannot get property "config" without inject
error typert-loader: dsh-session-trash exports "./typert" but importing ...\host\typert.mjs failed: ERR_MODULE_NOT_FOUND
```

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 配置读不到、face 没注册 | cordis 把配置作为**第二参数**传给 `apply(ctx, config)`；我先写了 `ctx.config`（未 inject 即抛） | 改成 `function apply(ctx, config)`，同步函数（同 dsh-dispatch / our-free-model / opencode2dsh） |
| typert-loader 报错 | `package.json` 声明了 `exports["./typert"]` 但文件不存在 —— 加载器对**已声明却加载失败**是 fail-loud | 删掉该导出（本插件走 typertGateway 的 **SRC 接收路径**，不需要 typert 清单） |
| （顺带）`createTrashPorts` 报 `config is not defined` | 我批量替换参数名时误改了**函数定义** | 定义与函数体统一用 `config`（host-face 测试第 1 次运行就抓到了） |

另有两处是**测试阶段**抓到、上线前修掉的：`assertInside` 原先放行"根目录自身"（一次误解析就可能端掉整棵树）、
多选行把 `Checkbox`（本身就是 `<label>`）再套一层 `<label>` 会导致点一下切两次。

## 生效方式

DSH **不持续监听** profile patch / 插件文件（实测：改文件不会自动重新加载），所以装完必须 **重启 DSH**。
重启后可到 `~/.dsh/logs/desktop-next-<日期>.0.jsonl` 里搜 `session-trash`，应看到一行 info：

```text
session-trash 就绪（日志根：C:\Users\<你>\.dsh\sessions，备份：…\trash-backup）
```

没有这一行就说明没激活（`启动降级` 则带具体原因）。
## 多选列表的主/子代理交互（2026-10-29 追加）

先说口径：**侧栏本来就过滤子代理**（`dsh-client-ui-workspace` 的 `sessionVisible`：
`if (session.origin === "subagent") return false`），所以"主列表不含子代理"这条对侧栏恒成立；
真正平铺子代理的是本插件的**多选批量删除对话框**。本次改的就是它。

| 需求 | 实现位置 | 做法 |
| --- | --- | --- |
| 1 默认收起 | `DeleteDialog` 的 `expanded`（`useState([])`）+ `Tree.showChildren` | 展示态与选中态分开存；每次打开对话框先 `setExpanded([])` |
| 2 子代理不进主列表 | `Tree.build().top`；多选入口 `MultiDeleteMenuItem` 也过滤一遍 | 判定与侧栏同源 `origin === "subagent"`；挂不上去的孤儿子代理**退回顶层**（否则永远删不到） |
| 3 / 5 选中主会话 → 子代理全选 | `Tree.family` / `Tree.toggleFamily` | 打开播种、全选按钮、单条删除播种统一走 family；取消勾选时子代理一并出列 |
| 4 展开/收起按钮 | 行内 chevron 按钮（`aria-expanded` / `title`） | 只改 `expanded`，完全不碰 `picked` |
| 6 仅主会话选中时生效 | `Tree.showChildren` 的第一道闸 | 父行未选中 → 不展示，且按钮 `disabled` 并提示「先选中主会话」；取消勾选同时自动收起 |

两个边界（都写了测试）：

- **委托深度 ≥2 的孙代理**：按 `parentSession` 直挂会挂到"子代理父行"名下，而子代理不进顶层 →
  孙代理会跟着一起消失、再也删不掉。改成沿血缘上溯到最近的**主会话**再挂（`resolveRoot`，带环/过深保护）。
- **分叉会话**：`fork` 只写 `parentSession` 不写 `origin`（`dsh-session` 的 `fork` 与 `session.fork` 两处都是），
  真子代理在 `dsh-subagent` 里**无条件**写 `origin: "subagent"`。所以判定**只认 origin**，
  分叉行与侧栏一样留在主列表 —— 若按血缘分，会把用户可见的分叉一起藏掉。

单条删除（会话「…」菜单 → 删除会话）同样连带其全部子代理，并在"将删除"里用**一行汇总**
（`含 {n} 个子代理会话`）而不是逐条平铺。

```text
node test/tree-logic.test.mjs   # 39 断言：直接抽取 client.js 的 @tree-logic 块跑验收
```
