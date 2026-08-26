import { c as sendJson, d as resolveConfig, i as readStoredToken, l as sendText, n as registerModuleSettingsRoute, r as sectionOverrides, s as readRawBody, u as urlPath } from "./settings-BKR5a7Xr.mjs";
import { n as genericCard, t as definePlainTool } from "./tools-CFxePexf.mjs";
import { t as runLlm } from "./llm--9Hv3AII.mjs";
import { timingSafeEqual } from "node:crypto";
//#region src/gitlab/api.ts
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
	return await readStoredToken(config.tokenEnv ?? "GITLAB_TOKEN");
}
async function glFetch(ctx, config, pathname, options = {}, signal) {
	const token = await resolveToken(ctx, config);
	if (!token) throw new Error(`GitLab token not configured: set env ${config.tokenEnv} (or via DSH credentials).`);
	const headers = {
		"PRIVATE-TOKEN": token,
		"user-agent": "dsh-reef"
	};
	let body;
	if (options.body !== void 0) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
	}
	let response;
	const retries = options.method === "GET" ? 2 : 0;
	for (let attempt = 0;; attempt++) try {
		response = await fetch(`${config.apiBase}${pathname}`, {
			method: options.method ?? "GET",
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
	if (!response.ok) throw new Error(`GitLab API ${response.status} for ${pathname}: ${JSON.stringify(data).slice(0, 500)}`);
	return data;
}
function projectIssue(issue) {
	return {
		iid: issue.iid,
		title: issue.title,
		state: issue.state,
		user: issue.author?.username ?? "",
		labels: issue.labels ?? [],
		created_at: issue.created_at,
		web_url: issue.web_url ?? ""
	};
}
function projectMr(mr) {
	return {
		iid: mr.iid,
		title: mr.title,
		state: mr.state,
		user: mr.author?.username ?? "",
		source_branch: mr.source_branch ?? "",
		target_branch: mr.target_branch ?? "",
		merged_at: mr.merged_at ?? null,
		web_url: mr.web_url ?? ""
	};
}
//#endregion
//#region src/gitlab/tools.ts
function registerTools(ctx, config) {
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	tools.register(definePlainTool({
		name: "gitlab_project",
		description: "获取 GitLab 项目信息(名称、星标、fork、open issues、默认分支)。",
		parameters: {
			type: "object",
			properties: { project: {
				type: "string",
				description: "项目路径,如 'owner/repo'。"
			} },
			required: ["project"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				path: { type: "string" },
				stars: { type: "integer" },
				forks: { type: "integer" },
				open_issues: { type: "integer" },
				default_branch: { type: "string" },
				web_url: { type: "string" }
			},
			required: [
				"name",
				"path",
				"stars",
				"forks",
				"open_issues",
				"default_branch",
				"web_url"
			]
		},
		render: (_args, value) => `${value.path} ⭐${value.stars} 🍴${value.forks} issues:${value.open_issues} default:${value.default_branch}`,
		presentCall: (args) => genericCard("gitlab", String(args.project), String(args.project)),
		timeoutMs: 3e4,
		execute: async (args) => {
			const data = await glFetch(ctx, config, `/projects/${encodeProject(args.project)}`);
			return {
				name: data.name ?? "",
				path: data.path_with_namespace ?? "",
				stars: data.star_count ?? 0,
				forks: data.forks_count ?? 0,
				open_issues: data.open_issues_count ?? 0,
				default_branch: data.default_branch ?? "",
				web_url: data.web_url ?? ""
			};
		}
	}));
	tools.register(definePlainTool({
		name: "gitlab_issues",
		description: "列出 GitLab 项目的 issue(state 默认 opened)。",
		parameters: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "项目路径,如 'owner/repo'。"
				},
				state: {
					type: "string",
					enum: [
						"opened",
						"closed",
						"all"
					]
				},
				limit: { type: "integer" }
			},
			required: ["project"],
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
		render: (_args, value) => value.issues.map((i) => `!${i.iid} [${i.state}] ${i.title} (${i.user})`).join("\n") || "(no issues)",
		timeoutMs: 3e4,
		execute: async (args) => {
			const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
			const state = args.state === "closed" ? "closed" : args.state === "all" ? "all" : "opened";
			return { issues: (await glFetch(ctx, config, `/projects/${encodeProject(args.project)}/issues?state=${state}&per_page=${limit}`) ?? []).map(projectIssue) };
		}
	}));
	tools.register(definePlainTool({
		name: "gitlab_mr_list",
		description: "列出 GitLab 项目的 Merge Request(state 默认 opened)。",
		parameters: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "项目路径,如 'owner/repo'。"
				},
				state: {
					type: "string",
					enum: [
						"opened",
						"closed",
						"merged",
						"all"
					]
				},
				limit: { type: "integer" }
			},
			required: ["project"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { mrs: {
				type: "array",
				items: { type: "object" }
			} },
			required: ["mrs"]
		},
		render: (_args, value) => value.mrs.map((m) => `!${m.iid} [${m.state}] ${m.title} (${m.user}) ${m.source_branch}→${m.target_branch}`).join("\n") || "(no merge requests)",
		timeoutMs: 3e4,
		execute: async (args) => {
			const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
			const state = args.state ?? "opened";
			return { mrs: (await glFetch(ctx, config, `/projects/${encodeProject(args.project)}/merge_requests?state=${state}&per_page=${limit}`) ?? []).map(projectMr) };
		}
	}));
}
//#endregion
//#region src/gitlab/settings.ts
const GITLAB_SETTING_FIELDS = [
	{
		key: "webhookSecret",
		label: "Webhook 密钥(Secret Token)",
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
		defaultValue: "open,update,reopen"
	},
	{
		key: "webhookPath",
		label: "Webhook 路径",
		type: "string",
		restart: true,
		defaultValue: "/reef/gitlab/webhook"
	}
];
//#endregion
//#region src/gitlab/webhook.ts
const REVIEW_SYSTEM_PROMPT = `你是资深代码评审员。请审阅下面这个 GitLab Merge Request 的变更,输出简洁的中文评审意见,格式:
## 总结
(2-4 句总体评价)
## 问题(按严重程度排序)
- [P0/P1/P2] 文件 — 问题与修改建议
## 亮点
(如有)
不要奉承,不要输出空话。只针对 diff 中真实存在的内容。`;
function verifyToken(rawBody, headerToken, secret) {
	if (!headerToken) return false;
	const a = Buffer.from(String(headerToken));
	const b = Buffer.from(secret);
	return a.length === b.length && timingSafeEqual(a, b);
}
function extractMrRef(payload) {
	const attrs = payload?.object_attributes;
	const project = payload?.project;
	if (!attrs || !project?.path_with_namespace) return void 0;
	return {
		project: project.path_with_namespace,
		iid: attrs.iid,
		title: attrs.title ?? "",
		description: attrs.description ?? "",
		action: attrs.action ?? "",
		state: attrs.state ?? "",
		sourceBranch: attrs.source_branch ?? "",
		targetBranch: attrs.target_branch ?? "",
		url: attrs.url ?? ""
	};
}
function buildMrReviewPrompt(mr, changes) {
	return `${`# MR !${mr.iid} ${mr.title}\n\n${mr.description ?? ""}\n\n分支:${mr.targetBranch} ← ${mr.sourceBranch}\n`}\n\n${(changes ?? []).map((file) => {
		const diff = file.diff ?? "(无 diff)";
		return `### ${file.new_path ?? file.old_path ?? "?"}\n\`\`\`diff\n${diff}\n\`\`\``;
	}).join("\n\n")}`;
}
async function handleWebhook(ctx, config, req, res) {
	const ov = sectionOverrides("gitlab", GITLAB_SETTING_FIELDS);
	const panelSecret = typeof ov.webhookSecret === "string" && ov.webhookSecret ? ov.webhookSecret : "";
	const envSecret = config.webhookSecretEnv ? process.env[config.webhookSecretEnv] : void 0;
	const secret = panelSecret || envSecret;
	const rawBody = await readRawBody(req);
	if (secret) {
		const token = req.headers["x-gitlab-token"];
		if (!verifyToken(rawBody, String(token ?? ""), secret)) {
			sendJson(res, 401, { error: "invalid token" });
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
	const mr = extractMrRef(payload);
	const reviewEvents = "autoReviewEvents" in ov ? String(ov.autoReviewEvents ?? "").split(",").map((s) => s.trim()).filter(Boolean) : config.autoReviewEvents ?? [];
	if (payload?.object_kind !== "merge_request" || mr === void 0 || mr.state !== "opened" || !reviewEvents.includes(mr.action)) {
		sendJson(res, 200, {
			received: true,
			handled: false,
			reason: "not a reviewable MR event"
		});
		return;
	}
	(async () => {
		try {
			const project = encodeProject(mr.project);
			await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}`);
			const changes = await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}/changes`);
			const prompt = buildMrReviewPrompt(mr, changes?.changes ?? []);
			const model = { ...config.reviewModel ?? {} };
			if (typeof ov.reviewModelProvider === "string" && ov.reviewModelProvider) model.provider = ov.reviewModelProvider;
			if (typeof ov.reviewModelModel === "string" && ov.reviewModelModel) model.model = ov.reviewModelModel;
			const aborted = new AbortController();
			const timer = setTimeout(() => aborted.abort(), 6e4);
			try {
				const review = await runLlm(ctx, model, REVIEW_SYSTEM_PROMPT, prompt.slice(0, config.reviewMaxDiffChars), aborted.signal, { maxTokens: 2e3 });
				if (!review) throw new Error("empty review output");
				await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}/notes`, {
					method: "POST",
					body: { body: `🤖 dsh-reef 自动评审\n\n${review.slice(0, 6e4)}` }
				});
				ctx.logger?.info?.(`dsh-reef/gitlab: reviewed ${mr.project}!${mr.iid}`);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			ctx.logger?.warn?.(`dsh-reef/gitlab: webhook review failed for ${mr.project}!${mr.iid}: ${error instanceof Error ? error.message : String(error)}`);
		}
	})();
	sendJson(res, 202, {
		received: true,
		handled: true,
		mr: mr.iid
	});
}
//#endregion
//#region src/gitlab/index.ts
const name = "reef-gitlab";
const inject = ["tools"];
const GITLAB_SCHEMA = {
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
	autoReviewEvents: { type: "string[]" }
};
const DEFAULT_CONFIG = {
	tokenEnv: "GITLAB_TOKEN",
	apiBase: "https://gitlab.com/api/v4",
	webhookPath: "/reef/gitlab/webhook",
	webhookSecretEnv: "GITLAB_WEBHOOK_SECRET",
	reviewModel: {},
	reviewMaxDiffChars: 6e4,
	autoReviewEvents: [
		"open",
		"update",
		"reopen"
	]
};
function registerWebhook(ctx, config) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	const base = (config.webhookPath ?? "/reef/gitlab/webhook").replace(/\/+$/, "");
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
	const disposeSettings = registerModuleSettingsRoute(ctx, base.replace(/\/webhook$/, ""), "gitlab", GITLAB_SETTING_FIELDS, config.tokenEnv ?? "GITLAB_TOKEN", "GitLab");
	ctx.effect(() => () => {
		try {
			dispose();
			disposeSettings();
		} catch {}
	});
}
function apply(ctx, rawConfig) {
	const resolved = resolveConfig("gitlab", GITLAB_SCHEMA, DEFAULT_CONFIG, rawConfig);
	if (ctx.get("tools") === void 0) return;
	if (typeof resolved.enabled === "boolean" && !resolved.enabled) return;
	const ov = sectionOverrides("gitlab", GITLAB_SETTING_FIELDS);
	const config = { ...resolved };
	if (typeof ov.webhookPath === "string" && ov.webhookPath) config.webhookPath = ov.webhookPath;
	registerTools(ctx, config);
	registerWebhook(ctx, config);
	const sectionDispose = ctx.get("systemPrompt")?.section?.({
		name: "tool:gitlab",
		order: 202,
		text: "GitLab 只读工具(gitlab_project / gitlab_issues / gitlab_mr_list)通过 GITLAB_TOKEN 访问 GitLab REST API。写操作(创建 issue/MR、评论)用 bash 配合 glab CLI(优先,UTF-8 安全)或 curl + GITLAB_TOKEN 完成。警告:Windows PowerShell 的 Invoke-RestMethod/Invoke-WebRequest 发含中文的 JSON body 会按 ISO-8859-1 编码变成乱码,必须用 [System.Text.Encoding]::UTF8.GetBytes($json) 传字节流,或改用 glab CLI;发布中文内容后回读一次校验无乱码,乱码立即删除重发。引用 issue/MR 时给出 !编号与链接。"
	});
	if (sectionDispose !== void 0) ctx.effect(() => sectionDispose);
}
//#endregion
export { apply, encodeProject, extractMrRef, inject, name, projectIssue, projectMr, verifyToken };
