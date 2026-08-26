import { c as sendJson, d as resolveConfig, i as readStoredToken, l as sendText, n as registerModuleSettingsRoute, r as sectionOverrides, s as readRawBody, u as urlPath } from "./settings-BKR5a7Xr.mjs";
import { n as genericCard, t as definePlainTool } from "./tools-CFxePexf.mjs";
import { t as runLlm } from "./llm--9Hv3AII.mjs";
import { createHmac, timingSafeEqual } from "node:crypto";
//#region src/github/api.ts
/** "owner/repo" → URL 编码的 project id(owner%2Frepo)。 */
function encodeProject(project) {
	return encodeURIComponent(String(project));
}
async function resolveToken(ctx, config) {
	try {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(config.tokenEnv);
			if (resolved?.value) return resolved.value;
		}
	} catch {}
	const envValue = config.tokenEnv ? process.env[config.tokenEnv] : void 0;
	if (envValue) return envValue;
	return await readStoredToken(config.tokenEnv ?? "GITHUB_TOKEN");
}
async function ghFetch(ctx, config, pathname, options = {}, signal) {
	const token = await resolveToken(ctx, config);
	const method = options.method ?? "GET";
	if (!token && method !== "GET") throw new Error(`GitHub token not configured: set env ${config.tokenEnv} (or via DSH credentials).`);
	const headers = {
		accept: "application/vnd.github+json",
		"user-agent": "dsh-reef"
	};
	if (token) headers.authorization = `Bearer ${token}`;
	let body;
	if (options.body !== void 0) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
	}
	let response;
	const retries = method === "GET" ? 2 : 0;
	for (let attempt = 0;; attempt++) try {
		response = await fetch(`${config.apiBase}${pathname}`, {
			method,
			headers,
			body,
			signal
		});
		if (attempt < retries && response.status >= 500) {
			await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
			continue;
		}
		break;
	} catch (error) {
		if (attempt < retries && signal?.aborted !== true) {
			await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
			continue;
		}
		throw error;
	}
	const text = await response.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { raw: text.slice(0, 500) };
	}
	if (!response.ok) {
		const hint = !token && response.status === 403 ? " (anonymous access is rate-limited to 60 req/h per IP; set GITHUB_TOKEN to lift)" : "";
		throw new Error(`GitHub API ${response.status} ${response.statusText} for ${pathname}: ${JSON.stringify(data).slice(0, 500)}${hint}`);
	}
	return data;
}
function projectIssue(issue) {
	return {
		number: issue.number,
		title: issue.title,
		state: issue.state,
		user: issue.user?.login ?? "",
		labels: (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? ""),
		comments: issue.comments ?? 0,
		created_at: issue.created_at,
		html_url: issue.html_url
	};
}
function projectPr(pr) {
	return {
		number: pr.number,
		title: pr.title,
		state: pr.state,
		draft: pr.draft === true,
		merged: pr.merged === true,
		user: pr.user?.login ?? "",
		head: pr.head?.ref ?? "",
		base: pr.base?.ref ?? "",
		additions: pr.additions ?? 0,
		deletions: pr.deletions ?? 0,
		changed_files: pr.changed_files ?? 0,
		created_at: pr.created_at,
		html_url: pr.html_url
	};
}
//#endregion
//#region src/github/tools.ts
function registerTools(ctx, config) {
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	tools.register(definePlainTool({
		name: "github_repo",
		description: "获取 GitHub 仓库的元信息(星标、fork、open issues、默认分支等)。",
		parameters: {
			type: "object",
			properties: {
				owner: { type: "string" },
				repo: { type: "string" }
			},
			required: ["owner", "repo"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				full_name: { type: "string" },
				description: { type: "string" },
				stars: { type: "integer" },
				forks: { type: "integer" },
				open_issues: { type: "integer" },
				default_branch: { type: "string" },
				html_url: { type: "string" },
				pushed_at: { type: "string" }
			},
			required: [
				"full_name",
				"description",
				"stars",
				"forks",
				"open_issues",
				"default_branch",
				"html_url",
				"pushed_at"
			]
		},
		render: (_args, value) => `${value.full_name} ⭐${value.stars} 🍴${value.forks} issues:${value.open_issues} default:${value.default_branch}`,
		presentCall: (args) => genericCard("github", `${args.owner}/${args.repo}`, `${args.owner}/${args.repo}`),
		timeoutMs: 3e4,
		execute: async (args) => {
			const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}`);
			return {
				full_name: data.full_name ?? "",
				description: data.description ?? "",
				stars: data.stargazers_count ?? 0,
				forks: data.forks_count ?? 0,
				open_issues: data.open_issues_count ?? 0,
				default_branch: data.default_branch ?? "",
				html_url: data.html_url ?? "",
				pushed_at: data.pushed_at ?? ""
			};
		}
	}));
	tools.register(definePlainTool({
		name: "github_issues",
		description: "列出仓库的 issue(state 默认 open)。",
		parameters: {
			type: "object",
			properties: {
				owner: { type: "string" },
				repo: { type: "string" },
				state: {
					type: "string",
					enum: [
						"open",
						"closed",
						"all"
					]
				},
				limit: { type: "integer" }
			},
			required: ["owner", "repo"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { issues: {
				type: "array",
				items: { type: "object" }
			} },
			required: ["issues"]
		},
		render: (_args, value) => value.issues.map((issue) => `#${issue.number} [${issue.state}] ${issue.title} (${issue.user})`).join("\n") || "(no issues)",
		timeoutMs: 3e4,
		execute: async (args) => {
			const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
			return { issues: (await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/issues?state=${args.state ?? "open"}&per_page=${limit}`) ?? []).map(projectIssue) };
		}
	}));
	tools.register(definePlainTool({
		name: "github_pulls",
		description: "列出仓库的 Pull Request(state 默认 open)。",
		parameters: {
			type: "object",
			properties: {
				owner: { type: "string" },
				repo: { type: "string" },
				state: {
					type: "string",
					enum: [
						"open",
						"closed",
						"all"
					]
				},
				limit: { type: "integer" }
			},
			required: ["owner", "repo"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { pulls: {
				type: "array",
				items: { type: "object" }
			} },
			required: ["pulls"]
		},
		render: (_args, value) => value.pulls.map((pr) => `#${pr.number} [${pr.state}] ${pr.title} (${pr.user}) +${pr.additions}/-${pr.deletions}`).join("\n") || "(no pull requests)",
		timeoutMs: 3e4,
		execute: async (args) => {
			const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
			return { pulls: (await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls?state=${args.state ?? "open"}&per_page=${limit}`) ?? []).map(projectPr) };
		}
	}));
	tools.register(definePlainTool({
		name: "github_pr",
		description: "获取单个 PR 的详情;includeFiles=true 时附带文件变更列表(含 diff patch)。",
		parameters: {
			type: "object",
			properties: {
				owner: { type: "string" },
				repo: { type: "string" },
				number: { type: "integer" },
				includeFiles: { type: "boolean" }
			},
			required: [
				"owner",
				"repo",
				"number"
			],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { pr: { type: "object" } },
			required: ["pr"]
		},
		render: (args, value) => `#${value.pr.number} ${value.pr.title}\n+${value.pr.additions}/-${value.pr.deletions} in ${value.pr.changed_files} files\n${args.includeFiles ? value.pr.files.map((f) => `${f.status} ${f.filename}`).join("\n") : ""}`,
		timeoutMs: 3e4,
		execute: async (args) => {
			const pr = projectPr(await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls/${args.number}`));
			if (args.includeFiles === true) pr.files = (await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls/${args.number}/files?per_page=50`) ?? []).map((file) => ({
				filename: file.filename,
				status: file.status ?? "",
				additions: file.additions ?? 0,
				deletions: file.deletions ?? 0,
				patch: file.patch ?? ""
			}));
			return { pr };
		}
	}));
}
//#endregion
//#region src/github/settings.ts
const GITHUB_SETTING_FIELDS = [
	{
		key: "webhookSecret",
		label: "Webhook 密钥(HMAC)",
		type: "password",
		defaultValue: ""
	},
	{
		key: "reviewModelProvider",
		label: "评审模型 provider(空=默认)",
		type: "string",
		defaultValue: ""
	},
	{
		key: "reviewModelModel",
		label: "评审模型 model(空=默认)",
		type: "string",
		defaultValue: ""
	},
	{
		key: "autoReviewEvents",
		label: "自动评审事件(逗号分隔,空=关闭)",
		type: "string",
		defaultValue: "opened,synchronize,reopened"
	},
	{
		key: "webhookPath",
		label: "Webhook 路径",
		type: "string",
		restart: true,
		defaultValue: "/reef/github/webhook"
	}
];
//#endregion
//#region src/github/review.ts
const reviewedPrs = /* @__PURE__ */ new Map();
const REVIEW_SYSTEM_PROMPT = `你是资深代码评审员。请审阅下面这个 Pull Request 的变更,输出简洁的中文评审意见,格式:
## 总结
(2-4 句总体评价)
## 问题(按严重程度排序)
- [P0/P1/P2] 文件:行号 — 问题与修改建议
## 亮点
(如有)
不要奉承,不要输出空话。只针对 diff 中真实存在的内容。`;
async function runReviewLlm(ctx, config, prompt, signal) {
	const ov = sectionOverrides("github", GITHUB_SETTING_FIELDS);
	const model = { ...config.reviewModel ?? {} };
	if (typeof ov.reviewModelProvider === "string" && ov.reviewModelProvider) model.provider = ov.reviewModelProvider;
	if (typeof ov.reviewModelModel === "string" && ov.reviewModelModel) model.model = ov.reviewModelModel;
	return runLlm(ctx, model, REVIEW_SYSTEM_PROMPT, prompt, signal, { maxTokens: 2e3 });
}
function buildReviewPrompt(pr, files) {
	return `${`# PR #${pr.number} ${pr.title}\n\n${pr.body ?? ""}\n\n分支:${pr.base?.ref ?? ""} ← ${pr.head?.ref ?? ""}\n改动:+${pr.additions ?? 0} / -${pr.deletions ?? 0},共 ${pr.changed_files ?? 0} 个文件\n`}\n\n${(files ?? []).map((file) => {
		const patch = file.patch ?? "(二进制或过大,无 patch)";
		return `### ${file.status ?? "modified"} ${file.filename} (+${file.additions ?? 0}/-${file.deletions ?? 0})\n\`\`\`diff\n${patch}\n\`\`\``;
	}).join("\n\n")}`;
}
async function reviewPullRequest(ctx, config, pr) {
	if (config.reviewDedupe !== false && pr.headSha) {
		const key = `${pr.owner}/${pr.repo}#${pr.number}:${pr.headSha}`;
		if (reviewedPrs.has(key)) {
			ctx.logger?.info?.(`dsh-reef/github: review dedupe hit for ${key}`);
			return { deduped: true };
		}
		reviewedPrs.set(key, Date.now());
		if (reviewedPrs.size > 200) {
			const oldest = reviewedPrs.keys().next().value;
			if (oldest !== void 0) reviewedPrs.delete(oldest);
		}
	}
	const prompt = buildReviewPrompt(await ghFetch(ctx, config, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {}), await ghFetch(ctx, config, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=30`));
	const aborted = new AbortController();
	const timer = setTimeout(() => aborted.abort(), 6e4);
	try {
		const review = await runReviewLlm(ctx, config, prompt.slice(0, config.reviewMaxDiffChars), aborted.signal);
		if (!review) throw new Error("empty review output");
		await ghFetch(ctx, config, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
			method: "POST",
			body: {
				body: review.slice(0, 6e4),
				event: "COMMENT"
			}
		});
		ctx.logger?.info?.(`dsh-reef/github: reviewed ${pr.owner}/${pr.repo}#${pr.number}`);
		return { reviewed: true };
	} finally {
		clearTimeout(timer);
	}
}
/** 并发锁:同一时间只跑一个自动修复任务。 */
//#endregion
//#region src/github/autofix.ts
let autoFixRunning = false;
function buildAutoFixPrompt(issue, dir, defaultBranch) {
	return [
		`你是 dsh-reef 的 issue 自动修复代理。请修复以下 GitHub issue:`,
		``,
		`#${issue.number} ${issue.title}`,
		``,
		issue.body ? issue.body : "(无正文)",
		``,
		`仓库本地路径:${dir}(已是 git 仓库,默认分支 ${defaultBranch})`,
		``,
		`流程要求:`,
		`1. 先 cd ${dir} 并 git fetch origin,然后 git checkout -b fix/issue-${issue.number} origin/${defaultBranch}`,
		`2. 定位问题并修复,尽量补充或运行测试验证`,
		`3. git add -A 并 git commit -m "Fix #${issue.number}: ${issue.title}"(若无变更则跳过提交)`,
		`4. git push origin fix/issue-${issue.number}(若远程已有同名分支,先 git push -f)`,
		`不要创建 PR,PR 由外部流程创建。`,
		`完成后报告:修改了哪些文件、修复思路、测试结果。`
	].join("\n");
}
async function runAutoFix(ctx, config, issue) {
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const defaultModel = ctx.get("agentDefaultModel");
	if (agents === void 0 || sessions === void 0 || defaultModel === void 0) throw new Error("agent services unavailable for auto-fix");
	const fullName = `${issue.owner}/${issue.repo}`;
	const dir = (config.autoFixRepos ?? {})[fullName];
	if (typeof dir !== "string" || dir.length === 0) return;
	if (Array.isArray(config.autoFixLabels) && config.autoFixLabels.length > 0) {
		const issueLabels = (issue.labels ?? []).map((l) => typeof l === "string" ? l : l.name ?? "");
		if (!config.autoFixLabels.some((l) => issueLabels.includes(l))) {
			ctx.logger?.info?.(`dsh-reef/github: auto-fix skipped (labels ${issueLabels.join(",")} not in ${config.autoFixLabels.join(",")})`);
			return;
		}
	}
	if (autoFixRunning) {
		ctx.logger?.warn?.("dsh-reef/github: auto-fix skipped — another fix is running");
		return;
	}
	autoFixRunning = true;
	let selection;
	try {
		selection = defaultModel.currentSelection();
	} catch (error) {
		autoFixRunning = false;
		throw new Error(`no default model configured: ${error instanceof Error ? error.message : String(error)}`);
	}
	const branch = "fix/issue-" + issue.number;
	const sessionId = `session-fix-${issue.owner}-${issue.repo}-${issue.number}`.replace(/[^A-Za-z0-9_-]/g, "-");
	let handle;
	try {
		const defaultBranch = (await ghFetch(ctx, config, `/repos/${issue.owner}/${issue.repo}`)).default_branch ?? "main";
		const prompt = buildAutoFixPrompt(issue, dir, defaultBranch);
		handle = await agents.create({
			sessionId,
			meta: { cwd: dir },
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			}
		});
		await handle.agent.whenIdle();
		handle.agent.followup({
			content: [{
				type: "text",
				text: prompt
			}],
			source: { kind: "user" }
		});
		await handle.agent.whenIdle();
		await sessions.flush(handle.agent.session);
		ctx.logger?.info?.(`dsh-reef/github: auto-fix agent finished for ${fullName}#${issue.number}`);
		const pr = await ghFetch(ctx, config, `/repos/${issue.owner}/${issue.repo}/pulls`, {
			method: "POST",
			body: {
				title: `Fix #${issue.number}: ${issue.title}`,
				head: branch,
				base: defaultBranch,
				body: `Closes #${issue.number}\n\nAuto-generated by dsh-reef (issue auto-fix).`
			}
		});
		ctx.logger?.info?.(`dsh-reef/github: auto-fix PR opened ${fullName}#${pr.number ?? "?"} — ${pr.html_url ?? ""}`);
		return {
			fixed: true,
			sessionId,
			prNumber: pr.number ?? null,
			prUrl: pr.html_url ?? ""
		};
	} catch (error) {
		ctx.logger?.warn?.(`dsh-reef/github: auto-fix failed for ${fullName}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
		return {
			fixed: false,
			sessionId,
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		if (handle !== void 0) try {
			await handle.dispose();
		} catch {}
		autoFixRunning = false;
	}
}
function extractIssueRef(payload) {
	const issue = payload?.issue;
	const repo = payload?.repository;
	if (!issue || !repo?.full_name) return void 0;
	const [owner, repoName] = repo.full_name.split("/");
	return {
		owner,
		repo: repoName,
		number: issue.number,
		title: issue.title ?? "",
		body: issue.body ?? "",
		labels: issue.labels ?? []
	};
}
//#endregion
//#region src/github/webhook.ts
const recentEvents = [];
function recordEvent(event, action, payload, handled, detail) {
	const repo = payload?.repository?.full_name ?? "";
	const number = payload?.pull_request?.number ?? payload?.issue?.number ?? payload?.number ?? null;
	recentEvents.push({
		ts: Date.now(),
		event,
		action,
		repo,
		number,
		title: payload?.pull_request?.title ?? payload?.issue?.title ?? "",
		handled: handled === true,
		detail: detail ?? ""
	});
	if (recentEvents.length > 50) recentEvents.shift();
}
function verifySignature(rawBody, signatureHeader, secret) {
	if (!signatureHeader) return false;
	const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
	const a = Buffer.from(expected);
	const b = Buffer.from(String(signatureHeader));
	return a.length === b.length && timingSafeEqual(a, b);
}
function extractPrRef(payload) {
	const pr = payload?.pull_request;
	const repo = payload?.repository;
	if (!pr || !repo?.full_name) return void 0;
	const [owner, repoName] = repo.full_name.split("/");
	return {
		owner,
		repo: repoName,
		number: pr.number,
		title: pr.title,
		body: pr.body ?? "",
		headSha: pr.head?.sha ?? "",
		base: pr.base?.ref ?? "",
		head: pr.head?.ref ?? "",
		additions: pr.additions ?? 0,
		deletions: pr.deletions ?? 0,
		changedFiles: pr.changed_files ?? 0,
		draft: pr.draft === true,
		htmlUrl: pr.html_url ?? ""
	};
}
async function handleWebhook(ctx, config, req, res) {
	const ov = sectionOverrides("github", GITHUB_SETTING_FIELDS);
	const panelSecret = typeof ov.webhookSecret === "string" && ov.webhookSecret ? ov.webhookSecret : "";
	const envSecret = config.webhookSecretEnv ? process.env[config.webhookSecretEnv] : void 0;
	const secret = panelSecret || envSecret;
	const rawBody = await readRawBody(req);
	if (secret) {
		const signature = req.headers["x-hub-signature-256"];
		if (!verifySignature(rawBody, String(signature ?? ""), secret)) {
			sendJson(res, 401, { error: "invalid signature" });
			return;
		}
	}
	let payload;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		sendJson(res, 400, { error: "invalid JSON" });
		return;
	}
	const event = String(req.headers["x-github-event"] ?? "");
	const action = payload?.action ?? "";
	if (event === "issues" && action === "opened" && payload?.issue !== void 0 && !payload.issue.pull_request) {
		const issue = extractIssueRef(payload);
		const fullName = issue ? `${issue.owner}/${issue.repo}` : "";
		if (issue !== void 0 && config.autoFixRepos !== void 0 && fullName in config.autoFixRepos) {
			recordEvent(event, action, payload, true, "auto-fix triggered");
			(async () => {
				try {
					await runAutoFix(ctx, config, issue);
				} catch (error) {
					ctx.logger?.warn?.(`dsh-reef/github: auto-fix flow failed for ${fullName}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
			sendJson(res, 202, {
				received: true,
				event,
				action,
				handled: true,
				autoFix: true,
				issue: issue.number
			});
			return;
		}
		recordEvent(event, action, payload, false, "repo not in autoFixRepos");
		sendJson(res, 200, {
			received: true,
			event,
			action,
			handled: false,
			reason: "repo not in autoFixRepos"
		});
		return;
	}
	const actionStr = String(action);
	const reviewEvents = "autoReviewEvents" in ov ? String(ov.autoReviewEvents ?? "").split(",").map((s) => s.trim()).filter(Boolean) : config.autoReviewEvents ?? [];
	if (event !== "pull_request" || !reviewEvents.includes(actionStr)) {
		recordEvent(event, actionStr, payload, false, "not handled");
		sendJson(res, 200, {
			received: true,
			event,
			action: actionStr,
			handled: false
		});
		return;
	}
	const pr = extractPrRef(payload);
	if (!pr || pr.draft) {
		recordEvent(event, action, payload, false, "draft or missing pr");
		sendJson(res, 200, {
			received: true,
			event,
			action,
			handled: false,
			reason: "draft or missing pr"
		});
		return;
	}
	recordEvent(event, action, payload, true, "review queued");
	(async () => {
		try {
			await reviewPullRequest(ctx, config, pr);
		} catch (error) {
			ctx.logger?.warn?.(`dsh-reef/github: webhook review failed for ${pr.owner}/${pr.repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
		}
	})();
	sendJson(res, 202, {
		received: true,
		event,
		action,
		handled: true,
		pr: pr.number
	});
}
//#endregion
//#region src/github/index.ts
const name = "reef-github";
const inject = ["tools"];
const GITHUB_SCHEMA = {
	enabled: {
		type: "boolean",
		optional: true
	},
	tokenEnv: { type: "string" },
	apiBase: { type: "string" },
	webhookPath: { type: "string" },
	webhookSecretEnv: { type: "string" },
	reviewModel: { type: "any" },
	reviewMaxDiffChars: {
		type: "number",
		min: 100
	},
	autoReviewEvents: { type: "string[]" },
	reviewDedupe: { type: "boolean" },
	autoFixRepos: { type: "any" },
	autoFixLabels: { type: "string[]" },
	autoFixTimeoutMs: {
		type: "number",
		min: 1e3
	}
};
const DEFAULT_CONFIG = {
	tokenEnv: "GITHUB_TOKEN",
	apiBase: "https://api.github.com",
	webhookPath: "/reef/github/webhook",
	webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
	reviewModel: {},
	reviewMaxDiffChars: 6e4,
	autoReviewEvents: [
		"opened",
		"synchronize",
		"reopened"
	],
	reviewDedupe: true,
	autoFixRepos: {},
	autoFixLabels: [],
	autoFixTimeoutMs: 6e5
};
function registerWebhook(ctx, config) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	const base = (config.webhookPath ?? "/reef/github/webhook").replace(/\/+$/, "");
	const dispose = webServer.register({
		kind: "exact",
		path: base,
		handler: (req, res) => {
			if (urlPath(req) !== base) {
				sendText(res, 404, "not found");
				return;
			}
			if ((req.method ?? "GET") !== "POST") {
				sendText(res, 405, "method not allowed");
				return;
			}
			handleWebhook(ctx, config, req, res).catch((error) => {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		}
	});
	const eventsPath = `${base.replace(/\/webhook$/, "")}/events`;
	const disposeEvents = webServer.register({
		kind: "exact",
		path: eventsPath,
		handler: (req, res) => {
			if ((req.method ?? "GET") !== "GET") {
				sendText(res, 405, "method not allowed");
				return;
			}
			sendJson(res, 200, { events: recentEvents });
		}
	});
	const disposeSettings = registerModuleSettingsRoute(ctx, base.replace(/\/webhook$/, ""), "github", GITHUB_SETTING_FIELDS, config.tokenEnv ?? "GITHUB_TOKEN", "GitHub");
	ctx.effect(() => () => {
		try {
			dispose();
			disposeEvents();
			disposeSettings();
		} catch {}
	});
}
function apply(ctx, rawConfig) {
	const resolved = resolveConfig("github", GITHUB_SCHEMA, DEFAULT_CONFIG, rawConfig);
	if (typeof resolved.enabled === "boolean" && !resolved.enabled) return;
	const ov = sectionOverrides("github", GITHUB_SETTING_FIELDS);
	const config = { ...resolved };
	if (typeof ov.webhookPath === "string" && ov.webhookPath) config.webhookPath = ov.webhookPath;
	registerTools(ctx, config);
	registerWebhook(ctx, config);
	const sectionDispose = ctx.get("systemPrompt")?.section?.({
		name: "tool:github",
		order: 201,
		text: "GitHub 只读工具(github_repo / github_issues / github_pulls / github_pr)访问 GitHub REST API;公共仓库无需 token(匿名 60 次/小时),配置 GITHUB_TOKEN 后无此限制且可访问私有仓库。写操作(创建 issue/PR、评论、评审、合并)用 bash 配合 gh CLI(优先,UTF-8 安全)或 curl + GITHUB_TOKEN 完成。警告:Windows PowerShell 的 Invoke-RestMethod/Invoke-WebRequest 发含中文的 JSON body 会按 ISO-8859-1 编码变成乱码,必须用 [System.Text.Encoding]::UTF8.GetBytes($json) 传字节流,或改用 gh CLI;发布中文内容后回读一次校验无乱码,乱码立即删除重发。引用 PR/issue 时给出 #编号与链接。"
	});
	if (sectionDispose !== void 0) ctx.effect(() => sectionDispose);
}
//#endregion
export { apply, buildReviewPrompt, encodeProject, extractIssueRef, extractPrRef, inject, name, projectIssue, projectPr, verifySignature };
