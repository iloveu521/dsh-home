# dsh-workdiff

工作区改动侧栏 + 底栏终端默认打开（DSH Web GUI 本地插件）。

## 功能

1. **右侧代码改动面板**
   - 默认展示当前会话开始后产生的「Agent 改动」，入口角标和自动展开也只响应这组改动。
   - 用户可切换到「Git 未提交」，查看当前分支相对 HEAD 的全部未提交改动。
   - 会话启动时记录已有工作区基线；即使 agent 继续修改了原本已被用户改动的同一文件，
     Agent 视图展开的 unified diff 也只显示会话开始后的部分。
   - 每个文件行显示状态徽标（M/A/D/U/R）与 `+N -M` 增删计数；点击行内展开 unified diff，
     `+` 绿 / `-` 红 / `@@` 高亮。
   - 非 Git 工作区显示提示。

2. **底栏可选设置（默认打开终端）**
   - 设置页新增「代码改动与底栏」卡片：开关「新会话自动打开底栏」默认开启。
   - 新会话开始（`bottomOpenedOnce === false`）时自动展开 dsh-better-sidebar 的底部面板；
     其自身的首次展开流程会打开一个终端标签（受其默认开启的
     `bottomPanelAutoTerminal` 偏好控制，可在「侧边卡片」设置中关闭）。
   - 已经手动开关过底栏的会话不会被打扰；在设置里关掉开关即完全停用。

## 安全边界

- `/workdiff/*` 仅接受 loopback 来源（LAN/公网访问返回 403）。
- `cwd` 必须是已存在目录；`file` 必须解析在工作区目录内。
- 只读取当前会话工作区的 git 状态、diff 和会话启动时的脏文件内容基线，与内置侧栏 fs/git 路由同一信任级别。

## 安装（本机）

```powershell
# 源码即插件包，挂在 ~/.dsh/plugin-src/dsh-workdiff
# 1) profile 依赖 + bundle 声明（package.json 中）
#    "dsh-workdiff": "link:../../plugin-src/dsh-workdiff"
#    dsh.profile.bundles 追加 "dsh-workdiff"
# 2) node_modules 软链
#    New-Item -ItemType Junction profiles/web/node_modules/dsh-workdiff -> plugin-src/dsh-workdiff
# 3) 重启 dsh web（~/.dsh/restart-dsh-web.ps1）
```

客户端为手写 bundle（ModuleLoader 格式，纯 CJS + React.createElement，无构建依赖）。

## 文件

- `lib/index.js` — host 半：设置 schema、`/workdiff/{status,diff,cwd}` 路由、git 执行。
- `lib/client.js` — 浏览器半：右侧改动分组、diff 渲染、自动展开、底栏自动打开、设置卡片。
