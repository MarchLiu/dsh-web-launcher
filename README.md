# @local/dsh-web-manager

从 DSH Desktop 内管理**独立的 CLI `dsh web` 服务**（即 `~/.dsh` 下、通常监听
`127.0.0.1:3080` 的那个 web GUI），提供启动 / 停止 / 重启 / 状态 / 日志。

## 能力

| 入口 | 说明 |
|---|---|
| Agent 工具 `dsh_web` | `status` / `start` / `stop` / `restart` / `logs`，返回 JSON |
| 侧边栏面板图标 + 中央面板 | 实时状态、按钮操作、访问地址（含 `?token=`）、日志查看器（过滤 / 自动刷新）、降级提示 |
| HTTP API（仅本机同源） | `/dsh-web-manager/api/{health,status,logs,start,stop,restart}` |

## 状态颜色

侧边栏图标、面板状态点和状态徽标按同一状态着色，扫一眼就能区分：

| 状态 | 颜色 | 判定 |
|---|---|---|
| 运行中 | 绿色 | 端口有监听，且是本插件拉起的进程或可识别的 `dsh web` |
| 已停止 | 灰色 | 没有监听，也没有失败记录 |
| 启动失败 | 红色 | 最近一次 `start` 没成功（`profile-missing` / `spawn-failed` / `ready-timeout` / 进程启动后退出等），或自己拉起的进程已退出 |
| 外部进程 / 执行中 | 琥珀色 | 端口被外部 `dsh web` 占用，或按钮操作正在进行 |

`status` 里新增两个字段：`state`（`running` / `stopped` / `failed` / `foreign`）和
`failure`（失败原因、详情、退出码）。失败记录保存在 Host 进程内存中，所以一次失败的
`start` 即使没有留下任何进程，面板也会保持红色并显示原因；再次启动成功、观察到服务已
在运行、或按下停止（包括本来就没在运行）都会清除它。Desktop 重启后内存记录不保留，
此时没有监听就显示为「已停止」。

## 环境隔离（与 Desktop）

spawn 出的 web 进程：

- `detached`（独立会话/setsid），Desktop 退出、插件重载都不会杀掉它；
- 环境变量**逐项构造**，`process.env` 不会被整体继承——`DSH_PROFILE` /
  `DSH_SESSION_ID` / `DSH_WEB_URL` / `DSH_SHELL` / `NODE_COMPILE_CACHE` / Desktop
  的 bin 目录一概不带。只有两项是**派生**而来的，别当成硬隔离：
  - `PATH` = `pathPrefix` + 从 Desktop 的 PATH 里剔除 `dsh-desktop` / `desktop.app`
    段后的剩余部分（所以 Homebrew、pnpm 等用户路径仍在）；
  - `LANG` 沿用 Desktop 的取值（缺失时 `en_US.UTF-8`）；`SHELL` / `TERM` 固定。
  面板上会展示实际下发的 env key 列表与实际 PATH 头三段；
- `cwd` 为 web profile 目录，**必须已存在**：缺失时 `start` 直接返回
  `profile-missing`，不会替你新建一个空 profile 把失败推迟到不可读的启动错误；
  stdout/stderr 追加到日志文件；
- 只会 SIGTERM/SIGKILL「自己拉起的进程」或命令行确实匹配 `dsh web` 的外部监听进程。

## 进程识别与接管（安全边界）

`looksLikeDshWeb()` 按 **argv** 判断，不是「同时出现 dsh 和 web」的宽松匹配：

- 某个 token 的 basename 必须是 `dsh` / `dsh.js` / `dsh.cjs` / `dsh.mjs`；
- 它之后第一个非 flag 参数必须是 `web`。

于是 `dsh web --no-open`、`node …/bin/dsh web`、`node …/dsh.js --verbose web`
通过；而 `dsh-desktop … web`、`dsh-web-manager … web`、`dsh serve --name web`
以及 Desktop 自身进程都不会被误杀。**宁可拒绝接管（false negative），也不误杀**
——外部进程接管被拒只是少一个便利，误杀是事故。

自己拉起的进程另有两重身份证据，因此不受上面这条限制：

- pid 文件里的 pid 仍存活；
- 该 pid 就是目标端口的监听者（pid 记录 + 端口归属）。

所以即使启动命令的 argv 特殊到 `looksLikeDshWeb` 不认，也不会被当成外部进程。
反过来，外部进程若写成 `dsh --log-level debug web`（`dsh` 后跟带值的全局 flag），
会被判为不匹配而**拒绝接管**；需要时先手动停掉那个实例。

## 降级与失败路径

- **`ps` 不可用**（缺失 / 被沙箱拒绝 / 超时）：`status` 不再整个 500，而是把 pid
  记录当作自有进程，返回 `degraded: ['process-inspection']`，面板显示黄色提示条；
  此时接管外部进程一律拒绝（fail closed），启动/停止自有进程仍可用。
- **快速失败**：profile 缺失 → `profile-missing`；命令不存在或被拒 →
  `spawn-failed`（`error` 事件一到就返回，不再空等 90s 就绪窗口，并清掉无效 pid 记录）。
- **pid 文件写不进去**：只降级为「无法标记 managed」，不影响已经起来的服务。

## 配置（cordis.patch.yml 的 `config` 字段，全部可选）

```yaml
- insert:
    - id: dsh-web-manager
      name: '@local/dsh-web-manager'
      config:
        name: dsh web                     # 面板/结果里显示的名字
        host: 127.0.0.1                   # 探测与监听判定的地址
        port: 3080
        dshHome: ~/.dsh
        profileDir: ~/.dsh/profiles/web   # 必须已存在
        logFile: ~/.dsh/logs/dsh-web-3080.log
        pidFile: ~/.dsh/run/dsh-web-manager-3080.pid
        command: [/opt/homebrew/bin/node, /opt/homebrew/bin/dsh, web, --no-open]
        pathPrefix: /opt/homebrew/bin
        extraEnv: {}            # 需要额外注入的环境变量（字符串值）
        allowForeignTakeover: true
        readyTimeoutMs: 90000
```

## 面板文案

- 面板文案通过 `ctx.locale.register('dshWebManager', { en, zh })` **一次注册**：
  两种语言要么都进、要么都不进，不会出现只有一种语言时回退成 key；
- 字典同时内联在 `client.js`，locale 服务不可用时面板回退到英文而不是显示 key；
- `locale/*.json` 只承载插件市场列表用的标题/描述。

## 安全

写入接口仅接受：回环连接 + 回环 `Host` 头（防 DNS rebinding）+ 宿主 request gate，
POST 还要求来源受信：

- 无 `Origin`/`Referer`：Desktop 用的是 `dsh-desktop://harness/` 页面（opaque origin），
  `HarnessShell` 代理转发时会剥离来源头，这属于可信托管调用；
- `dsh-desktop:` 来源：Desktop 壳自身；
- `http(s)` 来源：必须与请求 `Host` 完全同源；
- 其余（如 `Origin: null`、跨站来源、其它本地端口）一律 403。

## 备注

- `dsh web` 每次启动的 `?token=` 会变化，状态与工具结果里返回的是日志中**最后一条**。
- CLI 通过 npm 升级会覆盖 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/...` 下的文件；
  本插件只负责拉起/停止，不修改 DSH 自身文件。

## 开发工作流

本目录（`~/jobs/dsh-web-launcher`）是插件的**开发副本**，安装时由它生成 Desktop 的插件包。

DSH Desktop 的插件安装是**不可变 generation 快照**：安装时把目录内容复制进
`profiles/.generations/live/<id>`，运行时从快照加载，不会跟随本目录的变化。
（官方启动投影还会校验包根必须是真实目录，因此不支持软链到源目录。）

改完代码后的循环：

```bash
node scripts/verify.mjs            # 1. 离线自检（不用重启）
# 2. 把 package.json 的 version 递增（例如 1.0.8）
# 3. 重新安装：DSH 设置 → Plugins → 从 /Users/mars/jobs/dsh-web-launcher 安装
#    或让 Desktop 里的 agent 用 plugin_manager install_bundle 装
# 4. 重启 Harness：菜单「重启」（Ctrl+Shift+R）或退出重开，加载新 generation
```

`scripts/verify.mjs` 覆盖：工具/路由注册、请求栅栏的 8 种来源、`looksLikeDshWeb`
的接受/拒绝矩阵、快速失败（缺 profile、缺二进制）、启动失败 → 红色状态、停止清除失败、
i18n 键一致性，以及针对真实端口的只读状态/日志。它**不**动线上进程。

为什么必须重启：宿主按 URL 缓存已加载的 ESM 模块，替换安装只会切换下一代的文件，
不会热替换正在运行的 Host 半；所以在重启之前，工具与面板跑的都是**上一代**代码。

## 已知限制

- **首次安装或升级本插件后，需要重启一次 DSH Desktop**：宿主进程会缓存已加载的
  插件模块 generation，替换安装不会热替换已运行的 Host 半，重启后才加载新代码
  （面板路由与侧边栏图标随之生效）。
- 面板 API 只对回环 + 同源请求开放，因此经反向代理/远程域名访问 Desktop 时面板
  按钮不可用（工具不受影响）。
- 外部进程接管要求 `dsh` 后的第一个非 flag 参数就是 `web`；带值的全局 flag 会被
  拒绝（见「进程识别与接管」）。
