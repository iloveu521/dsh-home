# dsh-status-card

DSH WebUI 的 `/status` 命令插件。

运行 `/status` 后，在输入框上方显示一张实时卡片：

- **上下文窗口**：占用 / 容量（`projectedTokens` / `contextWindow`），带进度条（≥70% 警告、≥90% 危险色）
- **累计输入（计费）**：未缓存 + 缓存读 + 缓存写，附细分
- **累计输出**
- **缓存命中率**
- **组成估算**：系统提示 / 工具定义 / 对话内容（启发式）

数据全部来自 token-meter 的 session projections（`tokenUsage` / `contextPressure` / `contextBreakdown`），随推送帧自动刷新。卡片可用右上角 × 收起；再次运行 `/status` 重新显示。

结构：

- `lib/index.js` — Host 半：向 `ctx.commands` 注册 `/status`（不占用模型回合），结果文本作为会话流内的持久命令节点。
- `lib/client.js` — Client 半：监听会话快照中最新一次 `/status` 运行，在 `conversation.input.dock` 座位渲染卡片。
