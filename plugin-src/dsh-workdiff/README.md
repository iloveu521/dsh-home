# dsh-workdiff

工作区改动侧栏 + 底栏终端默认打开（DSH Web GUI 本地插件）。

## 功能

1. **左侧改动抽屉**
   - 官方左侧栏底部新增「改动」入口（`sidebar.footer.action`），带实时改动文件数角标。
   - 点击后在左侧（紧贴侧栏列）展开 340px 改动面板（`shell.overlay`），
     自动轮询 `/workdiff/status`（抽屉打开 2s / 关闭 5s），工作中修改的文件实时同步。
   - 每个文件行显示状态徽标（M/A/D/U/R）与 `+N -M` 增删计数；点击行内展开 unified diff，
     `+` 绿 / `-` 红 / `@@` 高亮，与工作区 HEAD 对比（未跟踪文件整文件全加）。
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
- 只读取当前会话工作区的 git 状态与 diff，与内置侧栏 fs/git 路由同一信任级别。

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
- `lib/client.js` — 浏览器半：侧栏入口、左侧抽屉、diff 渲染、底栏自动打开、设置卡片。
