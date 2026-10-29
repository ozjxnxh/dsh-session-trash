/**
 * dsh-session-trash —— 安装校验（node test/install-verify.cjs）。
 *
 * 逐条复刻宿主的三段解析，全部通过才认为装上了：
 *   ① profile cordis.patch.yml 能被 js-yaml 解析成数组，且 insert 恰有一条 session-trash；
 *   ② 以 profile 目录为锚点能 resolve 到本包（loader 用 ESM import(name)，锚点一致）；
 *   ③ exports["./client"] 指向的 bundle 存在且语法合法（客户端打包路径），
 *      exports["."] 指向的宿主入口可被 ESM import 并导出 apply/inject/Config。
 */
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

const PROFILE = process.env.DSH_PROFILE_DIR || require("os").homedir() + "\\.dsh\\profiles\\desktop";
const req = createRequire(path.join(PROFILE, "package.json"));
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) {
    console.error("断言失败 #" + checks + "：" + message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function main() {
  /* ① profile patch */
  const yaml = req("js-yaml");
  const patchText = fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8");
  const doc = yaml.load(patchText);
  ok(Array.isArray(doc), "cordis.patch.yml 仍是顶层数组");
  const mine = doc.filter((item) => item && Array.isArray(item.insert)
    && item.insert.some((row) => row && row.id === "session-trash"));
  ok(mine.length === 1, "session-trash 恰有一条 insert（当前 " + mine.length + " 条）");
  const entry = mine[0].insert.find((row) => row.id === "session-trash");
  ok(entry.name === "dsh-session-trash", "name 指向本包：" + entry.name);
  ok(entry.config && typeof entry.config === "object", "config 是对象（默认无覆盖）");

  /* ② 包解析（锚点 = profile 目录） */
  const pkgJsonPath = req.resolve("dsh-session-trash/package.json");
  /* junction 会被 Node 解析成真实路径，所以断言"链接本身在 profile 里 + 解析落地在工程目录"。 */
  const linkPath = path.join(PROFILE, "node_modules", "dsh-session-trash");
  const linkStat = fs.lstatSync(linkPath);
  ok(linkStat.isSymbolicLink(), "profile node_modules 里是链接：" + linkPath);
  ok(fs.statSync(linkPath).isDirectory(), "链接可读为目录");
  ok(pkgJsonPath.endsWith(path.join("dsh-session-trash", "package.json")), "从 profile 锚点解析成功：" + pkgJsonPath);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  ok(pkg.name === "dsh-session-trash", "包名一致");
  ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === "./cordis.patch.yml", "声明了 bundle.patch");
  ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === "web", "声明了 client.platform=web");
  ok(pkg.dsh.client.immediately === true, "client.immediately=true（启动即装载，否则菜单不会出现）");
  ok(pkg.dsh.client.inject.indexOf("@deepseek-ai/dsh-client-ui-workspace") >= 0, "client.inject 含 ui-workspace（菜单槽位声明方，保证装载次序）");

  /* 我们走 typertGateway 的 SRC 接收路径，不需要 exports["./typert"]：
   * 若声明了一个不存在的 typert 产物，dsh-typert-loader 会按"declared artifact broken"
   * fail-loud 并聚合进激活错误 —— 这是启动级风险，必须钉死。 */
  ok(pkg.exports["./typert"] === undefined, "不得声明不存在的 ./typert");
  /* 但 host 侧必须自带 SRC 标记（网关认领依据） */
  ok(true, "SRC 标记的运行时校验见 host-face.test.mjs");
  /* ③ 客户端 bundle 路径（与 client-modules 的 clientExportOf 同语义） */
  const clientTarget = typeof pkg.exports["./client"] === "string"
    ? pkg.exports["./client"]
    : (pkg.exports["./client"] && pkg.exports["./client"].default);
  ok(typeof clientTarget === "string", "exports[./client] 可解析");
  const clientPath = path.join(path.dirname(pkgJsonPath), clientTarget);
  ok(fs.existsSync(clientPath), "client bundle 存在：" + clientPath);
  const clientSource = fs.readFileSync(clientPath, "utf8");
  ok(clientSource.indexOf("window.__ModuleLoader__.load") === 0 || clientSource.indexOf("window.__ModuleLoader__.load") >= 0, "bundle 用 __ModuleLoader__.load 注册");
  ok(clientSource.indexOf("id: \"dsh-session-trash\"") >= 0, "模块 id 与包名一致");
  try {
    new Function(clientSource);
    ok(true, "client bundle 语法合法");
  } catch (error) {
    ok(false, "client bundle 语法错误：" + error.message);
  }
  ok(clientSource.indexOf("require(\"react\")") >= 0, "只依赖 shell 静态模块 react");
  ok(clientSource.indexOf("dsh-client-ui-primitives") >= 0, "用到静态表里的 primitives");
  ok(!/require\(\"fs\"\)|require\(\"path\"\)/.test(clientSource), "bundle 不碰 node 内置模块（purity gate）");

  /* ④ 宿主入口 */
  const hostPath = req.resolve("dsh-session-trash");
  ok(hostPath.slice(-13) === "host\\index.js" || hostPath.endsWith("host/index.js"), "宿主入口 = " + hostPath);
  return import(pathToFileURL(hostPath).href).then((mod) => {
    ok(typeof mod.apply === "function", "导出 apply");
    ok(Array.isArray(mod.inject), "导出 inject 数组: " + JSON.stringify(mod.inject));
    ok(mod.Config && typeof mod.Config["~standard"] === "object", "Config 是 Standard Schema v1（cordis 只认 ~standard.validate）");
    ok(typeof mod.Config["~standard"].validate === "function", "~standard.validate 是函数");
    const validated = mod.Config["~standard"].validate({ keepBackups: 3 });
    ok(validated && validated.value && validated.value.keepBackups === 3, "validate 通过并归一配置");
    ok(typeof mod.createRemoteFace === "function" && typeof mod.createTrashPorts === "function", "导出装配函数");
    console.log("install-verify.cjs 通过：" + checks + " 项断言（profile=" + PROFILE + "）");
  });
}

Promise.resolve().then(main).catch((error) => {
  if (!error || !error.message || error.message.indexOf("断言失败") < 0) console.error("FAIL:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
