# dsh-think-slice

长思考保护插件（常驻版）：**保证自动重试** + **思考切片续跑** + **结构化日志**。

## 解决的问题

1. `Provider returned error` / 429 / 423 / 5xx / 网络超时等失败导致任务直接终止、不重试；
2. 中断后重试或重启任务时，模型从零重新思考（几千 token 的推理白费）。

## 逻辑（v3-resident）

### 链路一 `llm/stream` 包装层
- 对每个流式请求计算指纹：`b64(sessionId | model | 消息条数 | 末消息JSON尾部600字符)`；
- 迭代 chunks 时累积纯思考阶段的 `reasoning-delta`；一旦出现正文增量标记"正文已开始"；
- `finish` 为 error/aborted 且正文未开始且推理 ≥120 字符 → 抢救为切片：
  与同指纹旧切片归并，12k 字符封顶，写入内存 Map 并原子落盘 `slices.json`；
- 同指纹请求再次进入且切片命中 → 克隆冻结的 GenerateOptions，
  messages 追加「续思前缀」user 消息（`<<<THINK_SLICE … >>>`），嵌套 `ctx.llm.stream` 无缝续跑。

### 链路二 `agent/request-error`（prepend 最外层）
- 放行：用户手动停止（signal aborted）、上下文溢出类（交给 compaction 修复）、未识别失败（交官方 retryPolicy）；
- 认领并重试：rateLimit(429) / locked(423·quota) / server(≥500) / transport(网络) / provider("Provider returned error") / empty(空响应)，status≥400 兜底按 server；
- 退避：优先 `providerRetryAfterMs`；否则指数×抖动(0.75~1.25)：429→5s起90s顶｜423→8s/120s｜server→2s/45s｜其余→1.5s/20s；
- 限额：每指纹 ≤10 次、累计等待 ≤15 分钟。

## 日志系统

- 目录：`$DSH_HOME/think-slice/logs/think-slice-YYYY-MM-DD.jsonl`（DSH_HOME 缺省 `~/.dsh`）；
- 行格式：`{"t":"ISO时间","lvl":"info|warn|error","ev":"事件名",...详情}`；
- 事件：`armed / captured / resumed / retry / retry-cap-reached / wait-budget-exhausted / upstream-threw / aborted-during-backoff / slice-store-saved / slice-store-save-failed / request-error-handler-failed`；
- 控制台同步镜像 `[think-slice] …` 行；保留 14 天自动清理。

## 切片持久化

- `$DSH_HOME/think-slice/slices.json`（原子写 tmp+rename）；dsh web 重启后加载，跨重启也能续思；
- 上限 50 条（按时间淘汰），TTL 48h。

## 接线（本 profile 已完成）

- `profiles/web/package.json` → `"dsh-think-slice": "link:../../plugin-src/dsh-think-slice"`
- `profiles/web/cordis.patch.yml` → `- insert: [- id: think-slice, name: dsh-think-slice]`
- 改动 `lib/index.js` 后需重启 dsh web 生效。

## 回滚（fail-loud 警告：包损坏会让 dsh web 无法启动）

1. 最小回滚：删除 `cordis.patch.yml` 里的 `- insert: - id: think-slice` 两行 → 重启；
2. 彻底移除：再删 package.json 里的 link 依赖行 + `pnpm install`；
3. 应急恢复历史会话：`.tools/repair-think-slice.mjs`（v1 时代坏事件修复脚本，仍在）。
