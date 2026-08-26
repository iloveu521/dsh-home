import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
//#region src/lib/config.ts
function typeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
function checkField(key, value, schema, errors) {
	if (value === void 0 || value === null) {
		if (!schema.optional) errors.push(`config.${key}: 必填但缺失`);
		return;
	}
	const t = typeOf(value);
	if (schema.type === "any") return;
	if (schema.type === "string[]") {
		if (t !== "array" || !value.every((v) => typeof v === "string")) errors.push(`config.${key}: 期望 string[] 实际 ${t}`);
		return;
	}
	if (t !== schema.type) {
		errors.push(`config.${key}: 期望 ${schema.type} 实际 ${t}`);
		return;
	}
	if (schema.type === "number") {
		const n = value;
		if (schema.max !== void 0 && n > schema.max) errors.push(`config.${key}: 超过上限 ${schema.max}`);
		if (schema.min !== void 0 && n < schema.min) errors.push(`config.${key}: 低于下限 ${schema.min}`);
	}
	if (schema.type === "string" && schema.enum !== void 0 && !schema.enum.includes(value)) errors.push(`config.${key}: 必须是 ${schema.enum.join(" / ")} 之一`);
}
/** 校验配置;返回错误列表(空 = 通过)。 */
function validateConfig(schema, config) {
	const errors = [];
	for (const [key, field] of Object.entries(schema)) checkField(key, config[key], field, errors);
	return errors;
}
/** 合并默认值 + 校验;抛错时带模块名前缀。 */
function resolveConfig(moduleName, schema, defaults, raw) {
	const config = {
		...defaults,
		...raw ?? {}
	};
	for (const [key, field] of Object.entries(schema)) if (field.default !== void 0 && config[key] === void 0) config[key] = field.default;
	const errors = validateConfig(schema, config);
	if (errors.length > 0) throw new Error(`dsh-reef/${moduleName}: 配置无效 — ${errors.join("; ")}`);
	return config;
}
//#endregion
//#region src/lib/http.ts
/** Parse the request URL pathname (query strings are ignored). */
function urlPath(req) {
	try {
		return new URL(req.url ?? "/", "http://x").pathname;
	} catch {
		return "/";
	}
}
/** Read the request body as a UTF-8 string (bounded). */
function readRawBody(req, limitBytes = 1e6) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** Read and parse a JSON request body; `undefined` when the body is empty. */
async function readJsonBody(req, limitBytes) {
	const raw = await readRawBody(req, limitBytes);
	if (!raw) return void 0;
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Send a JSON response. */
function sendJson(res, status, value, extraHeaders = {}) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...extraHeaders
	});
	res.end(body);
}
/** Send a plain text response. */
function sendText(res, status, text, headers = {}) {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		...headers
	});
	res.end(text);
}
/** Start an SSE response stream and return a writer. */
function openSse(res, headers = {}) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
		"x-accel-buffering": "no",
		...headers
	});
	res.write(": connected\n\n");
	return {
		send(event, data) {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		},
		comment(text) {
			res.write(`: ${text}\n\n`);
		},
		close() {
			try {
				res.end();
			} catch {}
		}
	};
}
//#endregion
//#region src/lib/credentials.ts
/** 自有 token 存储文件路径($DSH_HOME/.dsh-reef/tokens.json)。 */
function tokenStorePath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, ".dsh-reef", "tokens.json");
}
/** 旧名存储路径(dsh-trio 时代遗留,读取时自动迁移)。 */
function legacyTokenStorePath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, ".dsh-trio", "tokens.json");
}
function readStore() {
	const file = tokenStorePath();
	let raw = null;
	try {
		raw = readFileSync(file, "utf8");
	} catch {}
	if (raw === null) try {
		raw = readFileSync(legacyTokenStorePath(), "utf8");
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		writeFileSync(file, raw, { mode: 384 });
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
/** 读自有存储中的 token(ref 未存或为空时返回 undefined)。 */
async function readStoredToken(ref) {
	const value = readStore()[ref];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/** 写自有存储;空串表示清除。 */
async function writeStoredToken(ref, value) {
	const file = tokenStorePath();
	mkdirSync(dirname(file), {
		recursive: true,
		mode: 448
	});
	const store = readStore();
	if (value === "") delete store[ref];
	else store[ref] = value;
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 384 });
	renameSync(tmp, file);
}
/** 自有存储的配置状态(与 credentials.describe 同构)。 */
async function describeStoredToken(ref) {
	return await readStoredToken(ref) !== void 0 ? {
		configured: true,
		source: "store",
		writable: true
	} : {
		configured: false,
		source: "",
		writable: true
	};
}
/**
* 校验即将写入的凭据值:必须是字符串、长度受限;空串表示"清除"。
* 返回字符串表示合法值,返回 `{ error }` 表示拒绝。
*/
function validateCredentialValue(value) {
	if (typeof value !== "string") return { error: "value must be a string" };
	if (value.length === 0) return "";
	if (value.length > 2e3) return { error: "value too long" };
	return value;
}
/** 实际可用的后端:credentials 服务(挂载时)或插件自有存储。 */
async function usableBackend(ctx, tokenEnv) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) try {
		await credentials.describe(tokenEnv);
		return "credentials";
	} catch {}
	return "store";
}
/** token 配置状态(面板展示用,永不回传值)。 */
async function credentialStatus(ctx, tokenEnv, label) {
	const credentials = ctx.get("credentials");
	const status = {
		ref: tokenEnv,
		configured: false,
		source: "",
		writable: true
	};
	if (label !== void 0) status.label = label;
	if (await usableBackend(ctx, tokenEnv) === "credentials" && credentials !== void 0) {
		const desc = await credentials.describe(tokenEnv);
		status.configured = desc.configured;
		status.source = desc.source ?? "";
		status.writable = desc.writable !== false;
	}
	if (!status.configured) {
		if (process.env[tokenEnv]) {
			status.configured = true;
			status.source = "env";
			status.writable = false;
		} else {
			const desc = await describeStoredToken(tokenEnv);
			status.configured = desc.configured;
			status.source = desc.source;
		}
	}
	return status;
}
/** 写入或清除 token(credentials 服务 → 自有存储回退)。空串 = 清除。 */
async function writeCredential(ctx, tokenEnv, value) {
	const credentials = ctx.get("credentials");
	if (await usableBackend(ctx, tokenEnv) === "credentials" && credentials !== void 0) {
		if (value === "") await credentials.unset(tokenEnv);
		else await credentials.set(tokenEnv, value);
	} else await writeStoredToken(tokenEnv, value);
}
//#endregion
//#region src/lib/settings.ts
/** 设置存储文件路径($DSH_HOME/.dsh-reef/settings.json)。 */
function settingsStorePath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, ".dsh-reef", "settings.json");
}
/** 旧名存储路径(dsh-trio 时代遗留,读取时自动迁移)。 */
function legacySettingsStorePath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, ".dsh-trio", "settings.json");
}
/** 读取整个设置存储(文件缺失/损坏时返回空对象;旧名存储自动迁移)。 */
function readReefSettings() {
	const file = settingsStorePath();
	let raw = null;
	try {
		raw = readFileSync(file, "utf8");
	} catch {}
	if (raw === null) try {
		raw = readFileSync(legacySettingsStorePath(), "utf8");
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		writeFileSync(file, raw, { mode: 384 });
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
/**
* 校验单个字段值。返回 { ok: true, value } 或 { ok: false, error }。
* 空字符串对所有类型都表示"清除覆盖"(password 除外由调用方决定)。
*/
function validateFieldValue(spec, value) {
	if (value === "") return {
		ok: true,
		value: void 0
	};
	switch (spec.type) {
		case "boolean": return typeof value === "boolean" ? {
			ok: true,
			value
		} : {
			ok: false,
			error: `${spec.key} must be a boolean`
		};
		case "number": {
			if (typeof value === "number" && Number.isFinite(value)) return {
				ok: true,
				value
			};
			const num = Number(value);
			if (value !== "" && value !== null && Number.isFinite(num) && String(value).trim() !== "") return {
				ok: true,
				value: num
			};
			return {
				ok: false,
				error: `${spec.key} must be a finite number`
			};
		}
		case "enum":
			if (typeof value !== "string" || !(spec.options ?? []).includes(value)) return {
				ok: false,
				error: `${spec.key} must be one of: ${(spec.options ?? []).join(", ")}`
			};
			return {
				ok: true,
				value
			};
		default:
			if (typeof value !== "string") return {
				ok: false,
				error: `${spec.key} must be a string`
			};
			if (value.length > 2e3) return {
				ok: false,
				error: `${spec.key} too long`
			};
			return {
				ok: true,
				value
			};
	}
}
/**
* 校验并合并一个 section 的 patch 后原子写入。非法字段整批拒绝(先全部校验)。
*/
async function writeSettingsSection(section, patch, spec) {
	const allowed = new Map(spec.map((f) => [f.key, f]));
	const cleaned = {};
	for (const [key, value] of Object.entries(patch)) {
		const field = allowed.get(key);
		if (field === void 0) throw new Error(`unknown setting: ${section}.${key}`);
		const checked = validateFieldValue(field, value);
		if (!checked.ok) throw new Error(checked.error);
		if (checked.value === void 0) {
			cleaned[key] = "";
			continue;
		}
		cleaned[key] = checked.value;
	}
	const file = settingsStorePath();
	mkdirSync(dirname(file), {
		recursive: true,
		mode: 448
	});
	const store = readReefSettings();
	const sectionStore = { ...store[section] ?? {} };
	for (const [key, value] of Object.entries(cleaned)) if (value === "") delete sectionStore[key];
	else sectionStore[key] = value;
	store[section] = sectionStore;
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 384 });
	renameSync(tmp, file);
}
/**
* 读取某 section 的有效覆盖值(按 spec 校验,非法值丢弃)。
* 不含默认值——调用方自行回退到模块默认配置。
*/
function sectionOverrides(section, spec) {
	const stored = readReefSettings()[section];
	if (stored === void 0) return {};
	const allowed = new Map(spec.map((f) => [f.key, f]));
	const out = {};
	for (const [key, value] of Object.entries(stored)) {
		const field = allowed.get(key);
		if (field === void 0) continue;
		const checked = validateFieldValue(field, value);
		if (checked.ok && checked.value !== void 0) out[key] = checked.value;
	}
	return out;
}
/** 一个字段的展示状态(含当前有效值;password 不回显)。 */
function fieldState(field, overrides) {
	const base = {
		key: field.key,
		label: field.label,
		type: field.type,
		restart: field.restart === true,
		defaultValue: field.defaultValue
	};
	if (field.type === "enum") base.options = field.options ?? [];
	if (field.type === "password") {
		base.value = "";
		base.configured = typeof overrides[field.key] === "string" && overrides[field.key] !== "";
	} else base.value = field.key in overrides ? overrides[field.key] : field.defaultValue;
	return base;
}
/**
* 通用设置端点处理器:GET 返回 token 状态 + 字段状态;POST 接收
* `{ token?, fields? }`。tokenEnv 缺省时跳过 token 部分。
*/
async function handleModuleSettings(ctx, req, res, section, spec, tokenEnv, label) {
	const method = req.method ?? "GET";
	if (method === "GET") {
		const payload = { section };
		if (tokenEnv !== void 0) payload.token = await credentialStatus(ctx, tokenEnv, label);
		payload.fields = spec.map((f) => fieldState(f, sectionOverrides(section, spec)));
		sendJson(res, 200, payload);
		return;
	}
	if (method === "POST") {
		let body = {};
		try {
			body = JSON.parse(await readRawBody(req, 16384) || "{}");
		} catch {
			sendJson(res, 400, { error: "invalid JSON" });
			return;
		}
		try {
			if (tokenEnv !== void 0 && body.token !== void 0) {
				const checked = validateCredentialValue(body.token);
				if (typeof checked === "object") throw new Error(checked.error);
				await writeCredential(ctx, tokenEnv, checked);
			}
			if (body.fields !== void 0) {
				if (body.fields === null || typeof body.fields !== "object" || Array.isArray(body.fields)) throw new Error("fields must be an object");
				await writeSettingsSection(section, body.fields, spec);
			}
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const payload = {
			ok: true,
			section
		};
		if (tokenEnv !== void 0) payload.token = await credentialStatus(ctx, tokenEnv, label);
		payload.fields = spec.map((f) => fieldState(f, sectionOverrides(section, spec)));
		sendJson(res, 200, payload);
		return;
	}
	sendText(res, 405, "method not allowed");
}
/** 注册 exact 路由 `${base}/settings`(供无前缀路由冲突的模块使用)。 */
function registerModuleSettingsRoute(ctx, base, section, spec, tokenEnv, label) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return () => {};
	const settingsPath = `${base.replace(/\/+$/, "")}/settings`;
	return webServer.register({
		kind: "exact",
		path: settingsPath,
		handler: (req, res) => {
			handleModuleSettings(ctx, req, res, section, spec, tokenEnv, label).catch((error) => {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		}
	});
}
//#endregion
export { openSse as a, sendJson as c, resolveConfig as d, readStoredToken as i, sendText as l, registerModuleSettingsRoute as n, readJsonBody as o, sectionOverrides as r, readRawBody as s, handleModuleSettings as t, urlPath as u };
