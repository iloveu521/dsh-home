# dsh-friendly-steps（过程精简）

> Friendly process collapse for the DeepSeek Harness Web GUI — hides technical
> Think / tool-call rows behind a small summary pill, for non-technical readers.
> 100% presentation-only CSS + a `createRoot` pill on `document.body`; zero
> interference with React rendering.

把 DSH Web GUI 会话消息流里的技术过程行（Think / 工具调用 / 重试 / 压缩）
用纯 CSS 折叠，右下角浮条显示「✓ 已完成 N 步 · M 步未成功」，
点击浮条一键展开/收起全部过程。失败/中断的步骤计入折叠并在浮条红色反馈。

## 安装

```sh
# 直接从 GitHub 安装（无构建步骤，装完即用）
dsh plugin --profile web add github:dongwenxiu83-web/dsh-friendly-steps

# 桌面版 profile 名为 desktop 时：
dsh plugin --profile desktop add github:dongwenxiu83-web/dsh-friendly-steps
```

安装后重启 DSH 生效；之后升级插件只需重新执行安装命令并重启。

## 效果

- 过程行（Think / 工具调用 / 重试 / 压缩）纯 CSS 折叠，页面只剩对话正文
- 右下角浮条：`✓ 已完成 N 步`，出错时红色追加 `· M 步未成功`，
  运行中显示 `⏳ 正在处理…（已进行 N 步）`
- 点击浮条在「全部展开 ⇄ 全部收起」间切换

## v2 设计（零侵入）

- **行折叠 = 纯 CSS `display:none`**：所有行仍由官方 React 渲染和持有，
  不向 React 列表注入任何外来节点——v1 的"展开后内容消失"（React 重排
  移除注入节点）在本版结构上不可能发生。
- **浮条 = pet 同款官方模式**：`createRoot` 挂在 `document.body` 安全区。
- **计数节流 400ms**，只做几次选择器统计，无布局读取、无全量扫描——
  v1 的主线程风暴（页面卡死）在本版不存在。
- 任何 DOM 契约变化 → fail-open（按官方原样渲染），不会弄坏页面。

## 模式

| 模式 | 行为 |
|---|---|
| `minimal`（默认） | 折叠过程行 + 隐藏 Think + 显示浮条 |
| `brief` | 只隐藏 Think |
| `off` | 完全官方呈现 |

切换方式（浏览器控制台，立即生效并记忆）：

```js
dshFriendlySteps.setMode('minimal') // 或 'brief' / 'off'
dshFriendlySteps.debug()            // 排查：输出各行计数
```

## 挂载方式（本机开发）

- 包本体：本目录
- symlink：`~/.dsh/profiles/node_modules/dsh-friendly-steps` → 本目录
- insert 行：`~/.dsh/profiles/desktop/cordis.patch.yml`（id `friendly-steps`）
- 新增包需重启 DSH 生效；之后改 client.js 只需刷新页面

> 其他用户请用上方「安装」一节的命令，无需手动挂载。

## 卸载

1. 删除 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `friendly-steps` insert 段
2. 删除 symlink：`rm ~/.dsh/profiles/node_modules/dsh-friendly-steps`
3. 重启 DSH

## 抗升级说明

- 依赖官方 DOM 契约：`data-chat-flow-kind`、`[data-variant="think"]`、
  工具行内 `[data-tool][data-state]`（running / ok / error / stopped）
- 不依赖任何生成的 CSS 类名，不与 React 争 DOM
- DSH 升级后若契约变化，最坏表现是"不再折叠"（fail-open）

## 已知取舍

- 摘要是全局浮条而非每组一行（官方 tool-call renderer 可被 priority
  遮蔽，但官方行组件未导出，展开态无法交还官方渲染——故不遮蔽）。
- 浮条固定在右下角输入区上方，与其他右下角插件（如桌宠）可能相邻。
