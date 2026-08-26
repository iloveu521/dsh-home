import { a as openSse, c as sendJson, d as resolveConfig, l as sendText, o as readJsonBody, r as sectionOverrides, s as readRawBody, t as handleModuleSettings, u as urlPath } from "./settings-BKR5a7Xr.mjs";
import { randomBytes, randomUUID } from "node:crypto";
//#region src/mcp/settings.ts
const MCP_SETTING_FIELDS = [{
	key: "authToken",
	label: "访问 token(Bearer,空=不鉴权)",
	type: "password",
	defaultValue: ""
}, {
	key: "path",
	label: "MCP 端点路径",
	type: "string",
	restart: true,
	defaultValue: "/reef/mcp"
}];
//#endregion
//#region src/mcp/tools.ts
const MCP_TOOLS = [
	{
		name: "dsh_list_sessions",
		description: "列出这台机器上 DeepSeek Harness 的会话(含标题、工作目录、创建时间)。",
		inputSchema: {
			type: "object",
			properties: { limit: {
				type: "integer",
				description: "最多返回多少条,默认 50。"
			} }
		}
	},
	{
		name: "dsh_read_session",
		description: "读取一个 DSH 会话的事件摘要(消息、工具调用、完成原因)。",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "会话 id(形如 session-xxx)。"
				},
				maxEvents: {
					type: "integer",
					description: "最多返回多少条事件,默认 200,取最新。"
				}
			},
			required: ["sessionId"]
		}
	},
	{
		name: "dsh_search_sessions",
		description: "全文搜索 DSH 会话(标题/内容)。",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				limit: { type: "integer" }
			},
			required: ["query"]
		}
	},
	{
		name: "dsh_run_agent",
		description: "用 DSH 的默认模型启动一个一次性 agent 执行任务(prompt),等待其完成并返回最终文本。适合深度研究、代码审查、多步骤任务。耗时可能较长;若请求带 _meta.progressToken,会通过 notifications/progress 推送进度。",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "交给 agent 的任务描述。"
				},
				cwd: {
					type: "string",
					description: "工作目录(默认 DSH 进程目录)。"
				},
				provider: {
					type: "string",
					description: "覆盖默认模型的 provider(可选)。"
				},
				model: {
					type: "string",
					description: "覆盖默认模型的 model id(可选,与 provider 一起传)。"
				},
				timeoutMs: {
					type: "integer",
					description: "超时毫秒,默认 300000。"
				}
			},
			required: ["prompt"]
		}
	},
	{
		name: "dsh_agents_status",
		description: "列出当前运行中的 DSH agent(会话 id 与状态)。",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false
		}
	}
];
/** 汇总一次 agent 运行:提取最新 assistant 文本与结束原因(参照官方 headless 驱动)。 */
//#endregion
//#region src/mcp/sessions.ts
function summarize(events, firstSeq) {
	let started = false;
	let text = "";
	let reason = null;
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = (event.data?.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
			if (joined !== "") text = joined;
		}
		if (event.type === "turn/end") reason = event.data?.reason ?? null;
	}
	return {
		text,
		reason
	};
}
function truncate(text, maxChars) {
	if (typeof text !== "string") return "";
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断)` : text;
}
/** 事件 → 一行摘要(防御性投影,任何字段缺失都不抛错)。 */
function projectEvent(event, maxChars = 400) {
	const { seq, type, data } = event;
	const base = {
		seq,
		type
	};
	try {
		if (type === "assistant/message" || type === "user/message") {
			const text = (data?.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
			return {
				...base,
				text: truncate(text, maxChars)
			};
		}
		if (type === "tool/call") return {
			...base,
			name: data?.name ?? "",
			args: truncate(JSON.stringify(data?.arguments ?? {}), maxChars)
		};
		if (type === "tool/result") return {
			...base,
			error: data?.isError === true
		};
		if (type === "turn/end") return {
			...base,
			reason: data?.reason?.kind ?? null
		};
		return base;
	} catch {
		return base;
	}
}
async function listSessions(ctx, args) {
	const query = ctx.get("sessionQuery");
	if (query === void 0) throw new Error("sessionQuery service unavailable");
	const limit = Math.min(Math.max(Number(args?.limit ?? 50) || 50, 1), 200);
	const records = await query.listSessions();
	const rows = [];
	for (const record of records.slice(-limit).reverse()) {
		let title;
		try {
			title = (await query.readTitle(record.header.id))?.title ?? "";
		} catch {
			title = "";
		}
		rows.push({
			sessionId: record.header.id,
			title,
			cwd: record.header.cwd ?? "",
			createdAt: record.header.createdAt ?? 0,
			live: record.live === true,
			persisted: record.persisted === true
		});
	}
	return { sessions: rows };
}
async function readSession(ctx, args) {
	const query = ctx.get("sessionQuery");
	if (query === void 0) throw new Error("sessionQuery service unavailable");
	const sessionId = String(args?.sessionId ?? "");
	if (!sessionId) throw new Error("sessionId is required");
	const maxEvents = Math.min(Math.max(Number(args?.maxEvents ?? 200) || 200, 1), 2e3);
	const snapshot = await query.readSession(sessionId);
	const events = (snapshot.events ?? []).slice(-maxEvents).map((event) => projectEvent(event));
	return {
		sessionId,
		cwd: snapshot.session?.cwd ?? "",
		createdAt: snapshot.session?.createdAt ?? 0,
		events
	};
}
async function searchSessions(ctx, args) {
	const query = ctx.get("sessionQuery");
	if (query === void 0) throw new Error("sessionQuery service unavailable");
	const q = String(args?.query ?? "");
	if (!q) throw new Error("query is required");
	const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 100);
	return {
		query: q,
		hits: ((await query.searchSessions({
			query: q,
			limit
		})).hits ?? []).map((hit) => {
			const out = {};
			for (const key of [
				"sessionId",
				"title",
				"snippet",
				"score"
			]) if (hit[key] !== void 0) out[key] = hit[key];
			return out;
		})
	};
}
async function resourcesList(ctx, args) {
	const query = ctx.get("sessionQuery");
	if (query === void 0) return { resources: [] };
	const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 50);
	const records = await query.listSessions();
	const resources = [];
	for (const record of records.slice(-limit).reverse()) {
		let title = "";
		try {
			title = (await query.readTitle(record.header.id))?.title ?? "";
		} catch {}
		resources.push({
			uri: `dsh://sessions/${record.header.id}`,
			name: `${record.header.id}${title ? ` — ${title}` : ""}`,
			description: `DSH 会话${record.header.cwd ? ` (cwd: ${record.header.cwd})` : ""}`,
			mimeType: "application/json"
		});
	}
	return { resources };
}
async function resourcesRead(ctx, args) {
	const uri = String(args?.uri ?? "");
	const match = uri.match(/^dsh:\/\/sessions\/(.+)$/);
	if (!match) throw new Error(`unsupported resource uri: ${uri}`);
	const sessionId = match[1];
	const query = ctx.get("sessionQuery");
	if (query === void 0) throw new Error("sessionQuery service unavailable");
	const snapshot = await query.readSession(sessionId);
	const events = (snapshot.events ?? []).slice(-500).map((event) => projectEvent(event, 2e3));
	return { contents: [{
		uri,
		mimeType: "application/json",
		text: JSON.stringify({
			sessionId,
			cwd: snapshot.session?.cwd ?? "",
			createdAt: snapshot.session?.createdAt ?? 0,
			events
		}, null, 2)
	}] };
}
//#endregion
//#region src/mcp/agent.ts
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runAgent(ctx, args, onProgress, onDelta) {
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const defaultModel = ctx.get("agentDefaultModel");
	if (agents === void 0 || sessions === void 0 || defaultModel === void 0) throw new Error("agent services unavailable (need agents/sessions/agentDefaultModel)");
	const prompt = String(args?.prompt ?? "");
	if (!prompt.trim()) throw new Error("prompt is required");
	let selection;
	try {
		selection = defaultModel.currentSelection();
	} catch (error) {
		throw new Error(`no default model configured: ${error instanceof Error ? error.message : String(error)}`);
	}
	const agentOptions = {
		provider: String(args?.provider ?? "") || selection.provider,
		model: String(args?.model ?? "") || selection.model
	};
	const cwd = String(args?.cwd ?? "") || process.cwd();
	const sessionId = `session-${randomUUID()}`;
	onProgress?.(1, 4, "creating agent");
	const handle = await agents.create({
		sessionId,
		meta: { cwd },
		agentOptions
	});
	try {
		await handle.agent.whenIdle();
		const firstSeq = handle.agent.session.seq;
		onProgress?.(2, 4, "agent running");
		handle.agent.followup({
			content: [{
				type: "text",
				text: prompt
			}],
			source: { kind: "user" }
		});
		const donePromise = handle.agent.whenIdle();
		let seenSeq = firstSeq;
		let pushedText = "";
		while (true) {
			const events = handle.agent.session.events;
			for (const event of events) {
				if (event.seq <= seenSeq) continue;
				seenSeq = event.seq;
				if (event.type !== "assistant/message") continue;
				const text = (event.data?.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
				if (text.length > pushedText.length) {
					const delta = text.slice(pushedText.length);
					pushedText = text;
					onDelta?.(delta);
				}
			}
			if (await Promise.race([donePromise.then(() => "done"), sleep(500).then(() => "tick")]) === "done") break;
		}
		onProgress?.(3, 4, "collecting result");
		await sessions.flush(handle.agent.session);
		const outcome = summarize(handle.agent.session.events, firstSeq);
		onProgress?.(4, 4, "done");
		return {
			sessionId,
			text: truncate(outcome.text, 12e4),
			reasonKind: outcome.reason?.kind ?? null,
			reasonCode: outcome.reason?.error?.code ?? null
		};
	} finally {
		try {
			await handle.dispose();
		} catch {}
	}
}
async function agentsStatus(ctx) {
	const agents = ctx.get("agents");
	if (agents === void 0) throw new Error("agents service unavailable");
	const list = agents.list();
	const agentsOut = [];
	for (const agent of list) {
		let status = "unknown";
		try {
			status = agent.status ?? "unknown";
		} catch {}
		agentsOut.push({
			sessionId: agent.id,
			status
		});
	}
	return {
		agents: agentsOut,
		count: agentsOut.length
	};
}
//#endregion
//#region src/mcp/dispatch.ts
async function callMcpTool(ctx, name, args, onProgress, onDelta) {
	switch (name) {
		case "dsh_list_sessions": return listSessions(ctx, args);
		case "dsh_read_session": return readSession(ctx, args);
		case "dsh_search_sessions": return searchSessions(ctx, args);
		case "dsh_run_agent": return runAgent(ctx, args, onProgress, onDelta);
		case "dsh_agents_status": return agentsStatus(ctx);
		default: throw new Error(`unknown tool: ${name}`);
	}
}
//#endregion
//#region src/mcp/oauth.ts
/** OAuth client_credentials 签发的 token → 过期时间戳(ms)。 */
const oauthTokens = /* @__PURE__ */ new Map();
function isOAuthEnabled(config) {
	return config.oauthEnabled === true;
}
function oauthClientCredentials(config) {
	if (!isOAuthEnabled(config)) return void 0;
	const id = config.oauthClientIdEnv ? process.env[config.oauthClientIdEnv] : void 0;
	const secret = config.oauthClientSecretEnv ? process.env[config.oauthClientSecretEnv] : void 0;
	if (!id || !secret) return void 0;
	return {
		id,
		secret
	};
}
function checkOAuthToken(token) {
	if (!token) return false;
	const expiry = oauthTokens.get(token);
	if (expiry === void 0) return false;
	if (Date.now() > expiry) {
		oauthTokens.delete(token);
		return false;
	}
	return true;
}
/** 处理 POST token 端点(grant_type=client_credentials)。 */
async function handleOAuthToken(req, res, config) {
	const raw = await readRawBody(req, 16384);
	let params;
	try {
		params = new URLSearchParams(raw ?? "");
	} catch {
		sendJson(res, 400, {
			error: "invalid_request",
			error_description: "malformed form body"
		});
		return;
	}
	const grant = params.get("grant_type");
	const clientId = params.get("client_id");
	const clientSecret = params.get("client_secret");
	const expected = oauthClientCredentials(config);
	if (grant !== "client_credentials") {
		sendJson(res, 400, { error: "unsupported_grant_type" });
		return;
	}
	if (expected === void 0 || clientId !== expected.id || clientSecret !== expected.secret) {
		sendJson(res, 401, { error: "invalid_client" });
		return;
	}
	const token = randomBytes(24).toString("hex");
	oauthTokens.set(token, Date.now() + (config.oauthTokenTtlMs ?? 36e5));
	if (oauthTokens.size > 200) {
		const now = Date.now();
		for (const [k, v] of oauthTokens) if (v < now) oauthTokens.delete(k);
	}
	sendJson(res, 200, {
		access_token: token,
		token_type: "Bearer",
		expires_in: Math.floor((config.oauthTokenTtlMs ?? 36e5) / 1e3),
		scope: "dsh"
	});
}
/** OAuth 授权服务器元数据(RFC 8414)。 */
function oauthMetadata(config, host) {
	const base = `http://${host}${(config.path ?? "/reef/mcp").replace(/\/+$/, "")}`;
	return {
		issuer: base,
		token_endpoint: `${base}/oauth/token`,
		token_endpoint_auth_methods_supported: ["client_secret_post"],
		response_types_supported: [],
		grant_types_supported: ["client_credentials"],
		scopes_supported: ["dsh"],
		code_challenge_methods_supported: []
	};
}
//#endregion
//#region src/mcp/protocol.ts
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "dsh-reef-mcp";
const SERVER_VERSION = "1.0.1";
const sseWriters = /* @__PURE__ */ new Set();
/** 向所有已连接 SSE 客户端推送一条 JSON-RPC 通知。 */
function pushNotification(method, params) {
	for (const writer of sseWriters) try {
		writer.send("message", {
			jsonrpc: "2.0",
			method,
			params
		});
	} catch {
		sseWriters.delete(writer);
	}
}
/** 在 tools/call 执行期间报告进度(仅当客户端带 progressToken)。 */
function makeProgressReporter(params) {
	const token = params?._meta?.progressToken;
	if (token === void 0 || token === null) return void 0;
	let last = -1;
	return (progress, total, message) => {
		const rounded = Math.round(progress);
		if (rounded === last) return;
		last = rounded;
		pushNotification("notifications/progress", {
			progressToken: token,
			progress: rounded,
			total,
			message
		});
	};
}
/** run_agent 流式输出:轮询 agent 会话,把 assistant 文本增量推给客户端。 */
function makeDeltaReporter(params) {
	if (params?._meta?.streamOutput !== true && params?.stream !== true) return void 0;
	return (delta) => {
		pushNotification("notifications/message", {
			level: "info",
			logger: "dsh-reef.run-agent",
			data: {
				kind: "agent-delta",
				text: delta
			}
		});
	};
}
function rpcError(id, code, message) {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message
		}
	};
}
function rpcResult(id, result) {
	return {
		jsonrpc: "2.0",
		id,
		result
	};
}
function methodNotFound(id) {
	return rpcError(id, -32601, "Method not found");
}
function checkAuth(req, config) {
	const header = req.headers.authorization ?? "";
	const ov = sectionOverrides("mcp", MCP_SETTING_FIELDS);
	const panelToken = typeof ov.authToken === "string" && ov.authToken ? ov.authToken : "";
	if (panelToken && header === `Bearer ${panelToken}`) return true;
	if (config.authTokenEnv) {
		const token = process.env[config.authTokenEnv];
		if (token && header === `Bearer ${token}`) return true;
	}
	if (isOAuthEnabled(config)) {
		if (checkOAuthToken(header.startsWith("Bearer ") ? header.slice(7).trim() : "")) return true;
	}
	return !(panelToken || config.authTokenEnv || isOAuthEnabled(config));
}
function sendUnauthorized(res, config, req) {
	const host = req.headers.host ?? "127.0.0.1";
	const headers = {};
	if (isOAuthEnabled(config)) {
		headers["www-authenticate"] = `Bearer realm="${oauthMetadata(config, host).issuer}"`;
		headers["x-oauth-server-metadata"] = `http://${host}/.well-known/oauth-authorization-server`;
	} else headers["www-authenticate"] = "Bearer realm=\"dsh-reef-mcp\"";
	sendJson(res, 401, rpcError(null, -32001, "Unauthorized"), headers);
}
async function handlePost(req, res, ctx, config) {
	const path = urlPath(req);
	const base = (config.path ?? "/reef/mcp").replace(/\/+$/, "");
	if (isOAuthEnabled(config) && path === `${base}/oauth/token`) {
		await handleOAuthToken(req, res, config);
		return;
	}
	if (!checkAuth(req, config)) {
		sendUnauthorized(res, config, req);
		return;
	}
	let message;
	try {
		message = await readJsonBody(req);
	} catch (error) {
		sendJson(res, 400, rpcError(null, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`));
		return;
	}
	if (message === void 0) {
		sendJson(res, 400, rpcError(null, -32700, "empty body"));
		return;
	}
	const msg = message;
	const id = msg.id;
	const method = msg.method;
	const params = msg.params;
	const isNotification = id === void 0 || id === null;
	let response;
	switch (method) {
		case "initialize":
			response = rpcResult(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: {
					name: SERVER_NAME,
					version: SERVER_VERSION
				}
			});
			break;
		case "notifications/initialized":
		case "notifications/cancelled":
			if (isNotification) {
				res.writeHead(202, { "content-type": "application/json" });
				res.end();
				return;
			}
			response = rpcResult(id, {});
			break;
		case "ping":
			response = rpcResult(id, {});
			break;
		case "tools/list":
			response = rpcResult(id, {
				tools: MCP_TOOLS,
				resources: [{
					uri: "dsh://sessions",
					name: "DSH 会话列表",
					description: "列出最近的 DSH 会话资源(dsh://sessions/<id> 读取)。",
					mimeType: "application/json"
				}]
			});
			break;
		case "resources/list":
			try {
				response = rpcResult(id, await resourcesList(ctx, params));
			} catch (error) {
				response = rpcError(id, -32602, error instanceof Error ? error.message : String(error));
			}
			break;
		case "resources/read":
			try {
				response = rpcResult(id, await resourcesRead(ctx, params));
			} catch (error) {
				response = rpcError(id, -32602, error instanceof Error ? error.message : String(error));
			}
			break;
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			const onProgress = makeProgressReporter(params);
			const onDelta = makeDeltaReporter(params);
			try {
				const result = await callMcpTool(ctx, name, args, onProgress, onDelta);
				response = rpcResult(id, { content: [{
					type: "text",
					text: JSON.stringify(result, null, 2)
				}] });
			} catch (error) {
				response = rpcResult(id, {
					content: [{
						type: "text",
						text: error instanceof Error ? error.message : String(error)
					}],
					isError: true
				});
			}
			break;
		}
		default: response = methodNotFound(id);
	}
	if ((req.headers.accept ?? "").includes("text/event-stream")) {
		const writer = openSse(res);
		writer.send("message", response);
		writer.close();
	} else sendJson(res, 200, response);
}
function handleGetWithConfig(req, res, config) {
	if (!checkAuth(req, config)) {
		sendUnauthorized(res, config, req);
		return;
	}
	const writer = openSse(res);
	sseWriters.add(writer);
	const host = req.headers.host ?? "127.0.0.1";
	writer.send("endpoint", { uri: `http://${host}${config.path ?? "/reef/mcp"}` });
	const keepAlive = setInterval(() => writer.comment("keep-alive"), 15e3);
	req.on("close", () => {
		clearInterval(keepAlive);
		sseWriters.delete(writer);
		writer.close();
	});
}
//#endregion
//#region src/mcp/index.ts
const name = "reef-mcp";
const inject = ["webServer"];
const MCP_SCHEMA = {
	enabled: {
		type: "boolean",
		optional: true
	},
	path: { type: "string" },
	authTokenEnv: { type: "string" },
	oauthEnabled: { type: "boolean" },
	oauthClientIdEnv: { type: "string" },
	oauthClientSecretEnv: { type: "string" },
	oauthTokenTtlMs: {
		type: "number",
		min: 1e3
	},
	oauthTokenPath: { type: "string" },
	runAgentTimeoutMs: {
		type: "number",
		min: 1e3
	},
	runAgentMaxOutputChars: {
		type: "number",
		min: 100
	},
	listSessionsLimit: {
		type: "number",
		min: 1,
		max: 500
	}
};
const DEFAULT_CONFIG = {
	path: "/reef/mcp",
	authTokenEnv: "",
	oauthEnabled: false,
	oauthClientIdEnv: "MCP_CLIENT_ID",
	oauthClientSecretEnv: "MCP_CLIENT_SECRET",
	oauthTokenTtlMs: 36e5,
	oauthTokenPath: "/reef/mcp/oauth/token",
	runAgentTimeoutMs: 3e5,
	runAgentMaxOutputChars: 12e4,
	listSessionsLimit: 50
};
function apply(ctx, rawConfig) {
	const resolved = resolveConfig("mcp", MCP_SCHEMA, DEFAULT_CONFIG, rawConfig);
	if (typeof resolved.enabled === "boolean" && !resolved.enabled) return;
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	const ov = sectionOverrides("mcp", MCP_SETTING_FIELDS);
	const config = {
		...resolved,
		...typeof ov.path === "string" && ov.path ? { path: ov.path } : {}
	};
	const base = (config.path ?? "/reef/mcp").replace(/\/+$/, "");
	const disposers = [];
	disposers.push(webServer.register({
		kind: "prefix",
		path: base,
		handler: async (req, res) => {
			const path = urlPath(req);
			const method = req.method ?? "GET";
			if (path === `${base}/settings`) {
				await handleModuleSettings(ctx, req, res, "mcp", MCP_SETTING_FIELDS);
				return;
			}
			const isTokenPath = isOAuthEnabled(config) && path === `${base}/oauth/token`;
			if (path !== base && path !== `${base}/` && !isTokenPath) {
				sendText(res, 404, "not found");
				return;
			}
			if (method === "POST") {
				await handlePost(req, res, ctx, config);
				return;
			}
			if (method === "GET") {
				handleGetWithConfig(req, res, config);
				return;
			}
			if (method === "DELETE") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end();
				return;
			}
			sendText(res, 405, "method not allowed");
		}
	}));
	ctx.effect(() => () => {
		for (const dispose of disposers) try {
			dispose();
		} catch {}
	});
	const port = webServer.port;
	if (typeof port === "number") ctx.logger?.info?.(`dsh-reef/mcp: MCP server at http://127.0.0.1:${port}${base}`);
	if (isOAuthEnabled(config)) {
		const discoveryDispose = webServer.register({
			kind: "exact",
			path: "/.well-known/oauth-authorization-server",
			handler: (req, res) => {
				if ((req.method ?? "GET") !== "GET") {
					sendText(res, 405, "method not allowed");
					return;
				}
				const host = req.headers.host ?? `127.0.0.1:${port}`;
				sendJson(res, 200, oauthMetadata(config, host));
			}
		});
		disposers.push(discoveryDispose);
		ctx.logger?.info?.(`dsh-reef/mcp: OAuth client_credentials enabled — token endpoint ${base}/oauth/token`);
	}
}
//#endregion
export { MCP_TOOLS, apply, inject, name, projectEvent, rpcError, rpcResult, summarize, truncate };
