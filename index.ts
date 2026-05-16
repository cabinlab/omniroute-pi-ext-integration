/**
 * OmniRoute Manager — Pi Coding Agent Extension
 *
 * Manages OmniRoute (https://github.com/diegosouzapw/OmniRoute) from within
 * pi (https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
 *
 * Features:
 *   - Status bar shows which model actually served each response (via call logs when available)
 *   - Public API setup and model sync
 *   - Public-only mode for remote OmniRoute servers that block management endpoints
 *
 * Commands:
 *   /omni                  — Status dashboard
 *   /omni sync             — Sync all OmniRoute models to pi's Ctrl+P picker
 *   /omni setup            — Setup OmniRoute URL and API key
 *   /omni dashboard        — Show OmniRoute web dashboard URL
 *
 * Installation:
 *   1. Copy this file to ~/.pi/agent/extensions/omniroute-manager.ts
 *   2. Ensure OmniRoute is running
 *   3. Run /omni setup to configure URL and API key
 *   4. Start pi — the extension auto-loads and shows OmniRoute status.
 *
 * License: MIT
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";

function getOmniUrl(): string {
	try {
		const fs = require("fs");
		const data = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		const url = data?.providers?.omni?.baseUrl;
		if (url) return url.replace(/\/$/, "");
	} catch {}
	return "http://127.0.0.1:20128";
}

let OMNI_URL = getOmniUrl();
let DASHBOARD_URL = OMNI_URL;

function isOmniConfigured(): boolean {
	try {
		const fs = require("fs");
		const data = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		return !!data?.providers?.omni;
	} catch {
		return false;
	}
}

















// ────────────────────────── helpers ──────────────────────────

function modelsJsonPath(): string {
	return process.env.PI_HOME
		? `${process.env.PI_HOME}/models.json`
		: `${homedir()}/.pi/agent/models.json`;
}

function getApiKey(): string {
	try {
		const fs = require("fs");
		const data = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		return data?.providers?.omni?.apiKey || "";
	} catch {
		return "";
	}
}

async function api(path: string, opts?: RequestInit): Promise<any> {
	const apiKey = getApiKey();
	const res = await fetch(`${OMNI_URL}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			...(opts?.headers || {}),
		},
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) {
		const body = await res.text();
		const err: any = new Error(`${res.status}: ${body}`);
		err.status = res.status;
		err.body = body;
		throw err;
	}
	const text = await res.text();
	if (!text) return {};
	return JSON.parse(text);
}

function isManagementAuthError(error: any): boolean {
	const msg = String(error?.message || error || "").toLowerCase();
	const body = String(error?.body || "").toLowerCase();
	return msg.includes("invalid management token") ||
		msg.includes("authentication required") ||
		msg.includes("auth_001") ||
		body.includes("invalid management token") ||
		body.includes("authentication required") ||
		body.includes("auth_001");
}

function managementOnlyMessage(action: string): string {
	return `${action} unavailable: current OmniRoute server allows public model API but blocks management endpoints for API keys. Use /omni sync and normal model routing, or use OmniRoute dashboard session for management tasks.`;
}

// ────────────────────────── sanitization ──────────────────────────

function sanitize(str: string): string {
	if (typeof str !== "string") return String(str);
	let s = str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
	s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
	return s.slice(0, 500);
}

function sanitizeForUi(value: any): string {
	if (value === null || value === undefined) return "";
	return sanitize(String(value));
}

function safeNotify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(sanitizeForUi(message), level);
}

function safeStatus(ctx: any, key: string, message: string): void {
	ctx.ui.setStatus(key, sanitizeForUi(message));
}

// ────────────────────────── atomic write ──────────────────────────

function atomicWriteJson(filePath: string, data: any): void {
	const fs = require("fs");
	const tmpPath = filePath + ".tmp." + process.pid;
	const json = JSON.stringify(data, null, 2);
	fs.writeFileSync(tmpPath, json, "utf8");
	const fd = fs.openSync(tmpPath, "r");
	fs.fsyncSync(fd);
	fs.closeSync(fd);
	fs.renameSync(tmpPath, filePath);
	fs.chmodSync(filePath, 0o600);
}

function isLocalUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
	} catch {
		return false;
	}
}

function validateModels(models: any[]): any[] {
	const MAX_MODELS = 1000;
	const MAX_ID_LENGTH = 200;
	const MAX_NAME_LENGTH = 200;
	return models
		.filter((m) => {
			if (!m || !m.id) return false;
			if (typeof m.id !== "string") return false;
			if (m.id.length > MAX_ID_LENGTH) return false;
			return true;
		})
		.slice(0, MAX_MODELS)
		.map((m) => ({
			...m,
			id: sanitize(m.id),
			name: m.name ? sanitize(m.name).slice(0, MAX_NAME_LENGTH) : sanitize(m.id),
		}));
}

// ────────────────────────── health ──────────────────────────

async function checkOmniRouteHealth(): Promise<boolean> {
	try {
		const res = await fetch(`${OMNI_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

// ────────────────────────── combos ──────────────────────────

interface Combo {
	id: string;
	name: string;
	models: (string | { model: string; weight: number })[];
	strategy: string;
	isActive?: boolean;
}

async function listCombos(): Promise<Combo[]> {
	try {
		const data = await api("/api/combos");
		return data?.combos || data || [];
	} catch {
		return [];
	}
}

function comboLine(c: Combo, idx: number): string {
	const on = c.isActive !== false;
	const flag = on ? "✅" : "⬜";
	const count = c.models.length;
	return `${flag} ${idx + 1}. ${c.name}  [${c.strategy}, ${count} model${count !== 1 ? "s" : ""}]`;
}

// ────────────────────────── providers & connections ──────────────────────────

interface Connection {
	id: string;
	provider: string;
	authType: string;
	name: string;
	isActive: boolean;
	testStatus?: string;
	lastError?: string;
	errorCode?: string;
	projectId?: string;
	tokenExpiresAt?: string;
	expiresAt?: string;
	providerSpecificData?: { prefix?: string; nodeName?: string; baseUrl?: string };
}

interface ProviderNode {
	id: string;
	type: string;
	name: string;
	prefix: string;
	baseUrl: string;
}

async function listConnections(): Promise<Connection[]> {
	try {
		const data = await api("/api/providers");
		return data?.connections || [];
	} catch {
		return [];
	}
}

async function listProviderNodes(): Promise<ProviderNode[]> {
	try {
		const data = await api("/api/provider-nodes");
		return data?.nodes || [];
	} catch {
		return [];
	}
}

async function getProviderModels(connectionId: string): Promise<string[]> {
	try {
		const data = await api(`/api/providers/${connectionId}/models`);
		const models = data?.models || [];
		return models.map((m: any) => (typeof m === "string" ? m : m.id || m.name || String(m)));
	} catch {
		return [];
	}
}

function getDisconnectedProviders(connections: Connection[]): Connection[] {
	return connections.filter(
		(c) =>
			c.isActive &&
			(c.testStatus === "error" ||
				c.testStatus === "expired" ||
				c.errorCode === "refresh_failed" ||
				(c.lastError && c.lastError.includes("refresh failed")))
	);
}

// ────────────────────────── model picker ──────────────────────────

/** Multi-select model picker with grouped browsing by provider. */
async function pickModelsLoop(
	ctx: any,
	allModels: { id: string; name: string }[],
	currentModels: string[]
): Promise<string[] | null> {
	// Filter: only real models (must have provider/model format), skip combos
	// Also deduplicate aliases — prefer short prefixes (cx/ over codex/, kr/ over kiro/)
	const seen = new Map<string, string>(); // modelName → shortest prefixed ID
	for (const m of allModels) {
		if (!m.id.includes("/")) continue;
		const modelName = m.id.split("/").slice(1).join("/");
		const existing = seen.get(modelName);
		if (!existing || m.id.length < existing.length) {
			seen.set(modelName, m.id);
		}
	}
	const dedupedIds = new Set(seen.values());

	// Build a map to normalize any alias to its canonical (shortest) form
	const toCanonical = new Map<string, string>();
	for (const m of allModels) {
		if (!m.id.includes("/")) continue;
		const modelName = m.id.split("/").slice(1).join("/");
		const canonical = seen.get(modelName);
		if (canonical) toCanonical.set(m.id, canonical);
	}

	// Normalize currentModels to canonical form so ✅ marks show correctly
	const selected = new Set<string>(
		currentModels.map((m) => toCanonical.get(m) || m)
	);

	// Group models by provider
	const byProvider = new Map<string, string[]>();
	for (const id of dedupedIds) {
		const provider = id.split("/")[0];
		if (!byProvider.has(provider)) byProvider.set(provider, []);
		byProvider.get(provider)!.push(id);
	}
	const providers = Array.from(byProvider.keys()).sort();

	let picking = true;
	while (picking) {
		const summary = selected.size > 0
			? Array.from(selected).join(", ")
			: "(none)";

		// Top-level: pick a provider to browse, or finish
		const providerOpts = [
			`── Done (${selected.size} models selected) ──`,
			...providers.map((p) => {
				const models = byProvider.get(p)!;
				const count = models.filter((m) => selected.has(m)).length;
				const tag = count > 0 ? ` [${count} selected]` : "";
				return `${p}/ (${models.length} models)${tag}`;
			}),
		];

		const providerPick = await ctx.ui.select(`Models: ${summary}`, providerOpts);
		if (!providerPick || providerPick.startsWith("── Done")) {
			picking = false;
			continue;
		}

		// Extract provider name from "provider/ (N models) [X selected]"
		const providerName = providerPick.split("/")[0];
		const models = byProvider.get(providerName);
		if (!models) continue;

		// Browse models within this provider
		let browsingProvider = true;
		while (browsingProvider) {
			const modelOpts = [
				"← Back to providers",
				...models.map((m) => `${selected.has(m) ? "✅" : "⬜"} ${m}`),
			];

			const selectedCount = models.filter((m) => selected.has(m)).length;
			const modelPick = await ctx.ui.select(
				`${providerName}/ — ${selectedCount}/${models.length} selected`,
				modelOpts
			);

			if (!modelPick || modelPick === "← Back to providers") {
				browsingProvider = false;
			} else {
				const modelId = modelPick.replace(/^[✅⬜] /, "");
				if (selected.has(modelId)) {
					selected.delete(modelId);
				} else {
					selected.add(modelId);
				}
			}
		}
	}
	return selected.size > 0 ? Array.from(selected) : null;
}

// ────────────────────────── doctor diagnostics ──────────────────────────

interface DoctorIssue {
	severity: "error" | "warning" | "info";
	message: string;
	fix?: () => Promise<string>; // returns result message
}

/** Find combos with conn:-prefixed models and build fixes to replace with provider-level IDs */
function findConnPrefixedCombos(combos: Combo[], connections: Connection[]): DoctorIssue[] {
	const issues: DoctorIssue[] = [];
	const connMap = new Map(connections.map((c) => [c.id, c]));

	for (const combo of combos) {
		const models = combo.models.map((m) => (typeof m === "string" ? m : m.model));
		const connModels = models.filter((m) => m.startsWith("conn:"));
		if (connModels.length === 0) continue;

		// Build replacement: resolve conn:UUID/model → provider/model
		const replacements = new Map<string, string>();
		for (const cm of connModels) {
			const match = cm.match(/^conn:([^/]+)\/(.+)$/);
			if (!match) continue;
			const [, connId, modelName] = match;
			const conn = connMap.get(connId);
			const provider = conn?.provider || "unknown";
			replacements.set(cm, `${provider}/${modelName}`);
		}

		const fixedModels = models.map((m) => replacements.get(m) || m);
		// Deduplicate — multiple conn: entries may resolve to the same provider/model
		const uniqueModels = fixedModels.filter((m, i) => fixedModels.indexOf(m) === i);

		issues.push({
			severity: "error",
			message: `Combo "${combo.name}" uses ${connModels.length} connection-pinned model(s) (conn:…). ` +
				`These fail when that specific account's token expires. ` +
				`Fix: replace with provider-level IDs so OmniRoute can pick any healthy account.`,
			fix: async () => {
				await api(`/api/combos/${combo.id}`, {
					method: "PUT",
					body: JSON.stringify({ models: uniqueModels }),
				});
				return `✅ Fixed "${combo.name}": ${connModels.length} conn: refs → ${uniqueModels.join(", ")}`;
			},
		});
	}
	return issues;
}

/** Find antigravity accounts missing projectId and offer to deprioritize */
function findMissingProjectIds(connections: Connection[]): DoctorIssue[] {
	const broken = connections.filter((c) => c.provider === "antigravity" && c.isActive && !c.projectId);
	const healthy = connections.filter((c) => c.provider === "antigravity" && c.isActive && c.projectId);

	return broken.map((c) => ({
		severity: "warning" as const,
		message: `Antigravity account "${c.name}" is missing projectId — Google will reject requests with 400. ` +
			(healthy.length > 0
				? `${healthy.length} other antigravity account(s) are healthy. `
				: `Consider using Gemini AI Studio (API key) instead — it doesn't need a projectId. `) +
			`Reconnect in dashboard: ${DASHBOARD_URL} → Providers → disconnect & reconnect.`,
	}));
}

/** Find combos where all models depend on a single provider that has issues */
function findFragileCombos(combos: Combo[], connections: Connection[]): DoctorIssue[] {
	const issues: DoctorIssue[] = [];

	// Check which providers have healthy accounts
	const healthyProviders = new Set<string>();
	for (const c of connections) {
		if (c.isActive && c.testStatus === "active") {
			// For antigravity, only count if it has projectId
			if (c.provider === "antigravity" && !c.projectId) continue;
			healthyProviders.add(c.provider);
		}
	}

	// Check if gemini (AI Studio) is available as an alternative
	const hasGemini = healthyProviders.has("gemini");

	for (const combo of combos) {
		if (combo.isActive === false) continue;
		const models = combo.models.map((m) => (typeof m === "string" ? m : m.model));
		const providers = models.map((m) => m.split("/")[0]);
		const uniqueProviders = providers.filter((p, i) => providers.indexOf(p) === i);

		// All models use antigravity and it's broken
		const allAntigravity = uniqueProviders.length === 1 && uniqueProviders[0] === "antigravity";
		if (allAntigravity && !healthyProviders.has("antigravity") && hasGemini) {
			issues.push({
				severity: "error",
				message: `Combo "${combo.name}" uses only antigravity models (which have projectId issues). ` +
					`Gemini AI Studio is available and working — swap to gemini/ models?`,
				fix: async () => {
					// Map antigravity model names to gemini equivalents
					const mapped = models.map((m) => {
						const modelName = m.split("/").slice(1).join("/");
						return `gemini/${modelName}`;
					});
					// Verify the gemini models exist
					let available: string[] = [];
					try {
						const data = await api("/v1/models");
						available = (data?.data || []).map((m: any) => m.id).filter(Boolean);
					} catch {}
					const valid = mapped.filter((m) => available.includes(m));
					if (valid.length === 0) {
						// Fall back to popular gemini models
						valid.push("gemini/gemini-2.5-pro");
						if (combo.strategy === "round-robin") valid.push("gemini/gemini-2.5-flash");
					}
					await api(`/api/combos/${combo.id}`, {
						method: "PUT",
						body: JSON.stringify({ models: valid }),
					});
					return `✅ Fixed "${combo.name}": switched to ${valid.join(", ")}`;
				},
			});
		}

		// Combo has models from providers with zero healthy accounts
		const deadProviders = uniqueProviders.filter((p) => !healthyProviders.has(p));
		if (deadProviders.length > 0 && !allAntigravity) {
			const aliveModels = models.filter((m) => !deadProviders.includes(m.split("/")[0]));
			if (aliveModels.length === 0) {
				issues.push({
					severity: "warning",
					message: `Combo "${combo.name}" has no models from healthy providers ` +
						`(broken: ${deadProviders.join(", ")}). All requests will fail.`,
				});
			} else if (deadProviders.length > 0) {
				issues.push({
					severity: "info",
					message: `Combo "${combo.name}" includes models from unhealthy providers ` +
						`(${deadProviders.join(", ")}). These will be skipped at runtime.`,
				});
			}
		}
	}
	return issues;
}

/** Check if the pi models.json API key is configured (info-level only — OmniRoute
 *  doesn't enforce keys on the Anthropic /v1/messages endpoint that pi uses). */
function checkApiKey(): DoctorIssue[] {
	const key = getApiKey();
	if (!key) {
		return [{
			severity: "info",
			message: `No API key in models.json. This is fine for the /v1/messages endpoint pi uses.`,
		}];
	}
	return [];
}

/** Find combos with no models */
function findEmptyCombos(combos: Combo[]): DoctorIssue[] {
	return combos
		.filter((c) => c.models.length === 0)
		.map((c) => ({
			severity: "error" as const,
			message: `Combo "${c.name}" has no models. It will fail if selected. ` +
				`Add models in the dashboard: ${DASHBOARD_URL}`,
		}));
}

/** Check for accounts with expired or soon-to-expire tokens */
function findExpiringAccounts(connections: Connection[]): DoctorIssue[] {
	const issues: DoctorIssue[] = [];
	const now = Date.now();
	for (const c of connections) {
		if (!c.isActive) continue;
		
		const expiry = c.expiresAt || c.tokenExpiresAt;
		if (expiry) {
			const exp = new Date(expiry).getTime();
			if (exp < now) {
				issues.push({
					severity: "warning",
					message: `Account "${c.name}" (${c.provider}) session expired. Reconnect in dashboard.`,
				});
			} else if (exp < now + 1000 * 60 * 60 * 24) { // expires within 24h
				issues.push({
					severity: "info",
					message: `Account "${c.name}" (${c.provider}) session expires soon (within 24h).`,
				});
			}
		}
	}
	return issues;
}

// ────────────────────────── call log (resolved model tracking) ──────────────────────────

interface CallLog {
	id: string;
	model: string;
	provider: string;
	account: string;
	comboName?: string;
	status: number;
}

async function getLastCallLog(): Promise<CallLog | null> {
	try {
		const logs: CallLog[] = await api("/api/usage/call-logs?limit=1");
		return logs?.[0] || null;
	} catch {
		return null;
	}
}

// ────────────────────────── model sync ──────────────────────────

async function getAllModelsFromOmniRoute(): Promise<{ id: string; name: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] }[]> {
	const results: {
		id: string;
		name: string;
		owned_by?: string;
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
		input?: string[];
	}[] = [];

	// Models from built-in providers
	try {
		const data = await api("/v1/models");
		const models = data?.data || [];
		for (const m of models) {
			const id = typeof m === "string" ? m : m.id;
			if (id) {
				const res: any = {
					id,
					name: humanName(id),
					owned_by: m.owned_by,
					api: "openai-completions",
				};

				const cw = m.context_length || m.max_input_tokens;
				if (cw) res.contextWindow = cw;

				results.push(res);
			}
		}
	} catch {}

	// Models from custom provider nodes (OpenAI-compatible, etc.)
	try {
		const [connections, nodes] = await Promise.all([listConnections(), listProviderNodes()]);
		for (const node of nodes) {
			const nodeConns = connections.filter((c) => c.provider === node.id && c.isActive);
			for (const conn of nodeConns) {
				const models = await getProviderModels(conn.id);
				for (const modelId of models) {
					const prefixedId = `${node.prefix}/${modelId}`;
					if (!results.find((r) => r.id === prefixedId)) {
						results.push({
							id: prefixedId,
							name: humanName(prefixedId),
							owned_by: node.prefix,
						});
					}
				}
			}
		}
	} catch {}

	// Combos as selectable models
	try {
		const combos = await listCombos();
		for (const c of combos) {
			if (!results.find((r) => r.id === c.name)) {
				results.push({ id: c.name, name: c.name, owned_by: "0_combo" });
			}
		}
	} catch {}

	return results
		.sort((a, b) => {
			const ownedA = a.owned_by || "zz";
			const ownedB = b.owned_by || "zz";
			if (ownedA !== ownedB) return ownedA.localeCompare(ownedB);
			return a.id.localeCompare(b.id);
		})
		.map(({ owned_by, ...rest }) => rest);
}

function humanName(id: string): string {
	const parts = id.split("/");
	const provider = parts.length > 1 ? parts[0] : "";
	const model = parts.length > 1 ? parts.slice(1).join("/") : parts[0];

	let name = model
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());

	if (provider && name.toLowerCase().startsWith(provider.toLowerCase())) {
		name = name.slice(provider.length).trim();
		if (!name) name = model;
		name = name.charAt(0).toUpperCase() + name.slice(1);
	}

	return name;
}

// ════════════════════════════════════════════════════════════
// Extension entry point
// ════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let healthInterval: ReturnType<typeof setInterval> | undefined;
	let lastSeenLogId = ""; // ID of the most recent call log entry we've already displayed

	// ── Show resolved model in status bar after each response ──

	pi.on("message_end", async (event: any, ctx: any) => {
		try {
			const msg = event.message as any;
			if (msg?.role !== "assistant") return;

			// Wait briefly for OmniRoute to log the call, then check.
			// Two attempts: 500ms and 1500ms. Avoids the old 15×300ms poll loop.
			let log: CallLog | null = null;

			for (const delay of [500, 1000]) {
				await new Promise((r) => setTimeout(r, delay));
				const candidate = await getLastCallLog();
				if (candidate && candidate.id !== lastSeenLogId) {
					log = candidate;
					break;
				}
			}

			if (log) {
				lastSeenLogId = log.id;
				const combo = log.comboName ? `${log.comboName} → ` : "";
				const acct = log.account ? ` · ${log.account}` : "";
				const ok = log.status === 200;
				const suffix = ok ? "" : ` ✗${log.status}`;
				safeStatus(ctx, "omni", `${combo}${log.model} (${log.provider}${acct})${suffix}`);
			}
		} catch {}
	});

	// ── Show predicted routing when model selection changes ──

	pi.on("model_select", async (event: any, ctx: any) => {
		try {
			const modelId = (event.model as any)?.id ?? "";
			if (!modelId) return;

			// Check if the selected model is a combo
			const combos = await listCombos();
			const combo = combos.find((c) => c.name === modelId);

			if (!combo) {
				// Plain model, just show it
				safeStatus(ctx, "omni", `→ ${modelId}`);
				return;
			}

			// For combos, show the ordered model list so user knows what to expect
			const models = combo.models.map((m) =>
				typeof m === "string" ? m : m.model
			);
			const preview = models.slice(0, 3).join(" › ");
			const more = models.length > 3 ? ` +${models.length - 3}` : "";
			safeStatus(ctx, "omni", `${combo.name} [${combo.strategy}]: ${preview}${more}`);
		} catch {}
	});

	// ── Startup: health check + disconnected provider warnings ──

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!isOmniConfigured()) {
			ctx.ui.setStatus("omni", "OmniRoute (unconfigured)");
			ctx.ui.notify("OmniRoute is unconfigured. Run /omni setup to connect it.", "warning");
			return;
		}

		const healthy = await checkOmniRouteHealth();
		ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓" : "OmniRoute ✗");

		if (healthy) {
			try {
				const [combos, conns] = await Promise.all([listCombos(), listConnections()]);
				const active = combos.filter((c) => c.isActive !== false).length;
				const disconnected = getDisconnectedProviders(conns);

				ctx.ui.notify(`OmniRoute ready — ${combos.length} combos (${active} active)`, "info");

				if (disconnected.length > 0) {
					const names = disconnected
						.map((c) => {
							const psd = c.providerSpecificData || {};
							return `  ❌ ${psd.nodeName || c.provider}: ${c.name} — ${c.lastError || c.errorCode || "disconnected"}`;
						})
						.join("\n");
					safeNotify(ctx,
						`⚠️ ${disconnected.length} provider(s) need re-authentication:\n${names}\n\nOpen ${DASHBOARD_URL} → Providers to re-connect.`,
						"warning"
					);
				}

				// Proactive diagnostics on startup
				const issues = [
					...checkApiKey(),

					...findConnPrefixedCombos(combos, conns),
					...findEmptyCombos(combos),
					...findFragileCombos(combos, conns),
					...findMissingProjectIds(conns),
					...findExpiringAccounts(conns),
				];
				const fixable = issues.filter((i) => i.fix);
				const warnings = issues.filter((i) => !i.fix && i.severity !== "info");

				if (fixable.length > 0) {
					ctx.ui.notify(
						`⚠️ ${fixable.length} auto-fixable issue(s) detected. Run /omni doctor to diagnose & fix.`,
						"warning"
					);
				}
				if (warnings.length > 0) {
					for (const w of warnings) {
						safeNotify(ctx, `⚠️ ${w.message}`, "warning");
					}
				}
			} catch (e: any) {
				if (isManagementAuthError(e)) {
					ctx.ui.setStatus("omni", "OmniRoute ✓ public-only");
					ctx.ui.notify(managementOnlyMessage("Management features"), "warning");
				} else {
					throw e;
				}
			}
		} else {
			safeNotify(ctx,
				`OmniRoute not reachable at ${OMNI_URL}\n\nCheck your URL setting or run /omni setup.`,
				"warning"
			);
		}

		// Periodic health check — only update status if OmniRoute goes down
		// (avoids overwriting the resolved model display)
		healthInterval = setInterval(async () => {
			const h = await checkOmniRouteHealth();
			if (!h) ctx.ui.setStatus("omni", "OmniRoute ✗");
		}, 60_000);
	});

	pi.on("session_shutdown", async () => {
		if (healthInterval) clearInterval(healthInterval);
	});

	// ── /omni command ──

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [sync|setup|dashboard]",
		getArgumentCompletions(prefix: string) {
			return ["sync", "setup", "dashboard"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		async handler(args: string, ctx: any) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "";

			// ──────────────── /omni (status dashboard) ────────────────

			if (!sub) {
				const healthy = await checkOmniRouteHealth();
				try {
					const [combos, conns] = await Promise.all([
						listCombos(),
						listConnections(),
					]);

					const active = combos.filter((c) => c.isActive !== false).length;
					const activeConns = conns.filter((c) => c.isActive).length;
					const disconnected = getDisconnectedProviders(conns);

					const lines = [
						"═══ OmniRoute Status ═══",
						"",
						`  OmniRoute: ${healthy ? "✅ healthy" : "❌ DOWN"} (${OMNI_URL})`,
						"",
						"─── Combos ───",
						"",
						...combos.map((c, i) => "  " + comboLine(c, i)),
						...(combos.length === 0 ? ["  (none — create in dashboard)"] : []),
						"",
						"─── Providers ───",
						"",
						`  ${activeConns}/${conns.length} connections active`,
					];

					if (disconnected.length > 0) {
						lines.push("");
						lines.push("  ⚠️  Needs re-auth:");
						for (const c of disconnected) {
							const psd = c.providerSpecificData || {};
							lines.push(`    ❌ ${psd.nodeName || c.provider}: ${c.name}`);
						}
						lines.push(`    → Open ${DASHBOARD_URL} → Providers`);
					}

					lines.push(
						"",
						"─── Commands ───",
						"",
						"  /omni sync            Sync models to Ctrl+P picker",
						"  /omni setup           Save OmniRoute URL and API key",
						"  /omni dashboard       Dashboard URL",
					);

					safeNotify(ctx, lines.join("\n"), "info");
					ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓" : "OmniRoute ✗");
				} catch (e: any) {
					if (!isManagementAuthError(e)) throw e;
					safeNotify(ctx, [
						"═══ OmniRoute Status ═══",
						"",
						`  OmniRoute: ${healthy ? "✅ healthy" : "❌ DOWN"} (${OMNI_URL})`,
						"  Mode: public-only",
						"",
						"Management endpoints blocked for API-key auth on this server.",
						"",
						"Supported:",
						"  /omni sync            Sync public model list to Ctrl+P picker",
						"  /omni setup           Save OmniRoute URL and API key",
						"  /omni dashboard       Show dashboard URL",
					].join("\n"), "info");
					ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓ public-only" : "OmniRoute ✗");
				}
				return;
			}

			// ──────────────── /omni combos ────────────────

			if (sub === "__disabled_combos__") {
				ctx.ui.notify(managementOnlyMessage("/omni combos"), "warning");
				return;
			}

			// ──────────────── /omni providers ────────────────

			if (sub === "__disabled_providers__") {
				ctx.ui.notify(managementOnlyMessage("/omni providers"), "warning");
				return;
			}

			// ──────────────── /omni sync ────────────────

			if (sub === "sync") {
				ctx.ui.notify("Syncing models from OmniRoute to Ctrl+P picker...", "info");

				try {
					const allModels = await getAllModelsFromOmniRoute();
					const fs = require("fs");
					const path = modelsJsonPath();
					const config = JSON.parse(fs.readFileSync(path, "utf8"));

					if (!config.providers?.omni) {
						ctx.ui.notify(
							"No 'omni' provider found in models.json.\n" +
							"Add one first — see the extension header docs for the format.",
							"error"
						);
						return;
					}

					const oldCount = config.providers.omni.models?.length || 0;
					config.providers.omni.models = validateModels(allModels);
					atomicWriteJson(path, config);
	

					// Reload registry immediately — no restart needed
					ctx.modelRegistry.refresh();

					ctx.ui.notify(
						`✅ Synced ${allModels.length} models to Ctrl+P (was ${oldCount})`,
						"info"
					);
				} catch (e: any) {
					safeNotify(ctx, `Sync failed: ${e.message}`, "error");
				}
				return;
			}

			// ──────────────── /omni health (merged log-review + doctor) ────────────────

			if (sub === "__disabled_health__") {
				ctx.ui.notify(managementOnlyMessage("/omni health"), "warning");
				return;
			}

			// ──────────────── /omni setup ────────────────

			if (sub === "setup") {
				const fs = require("fs");
				const path = modelsJsonPath();

				// Get OmniRoute URL
				const urlInput = await ctx.ui.input(
					"OmniRoute URL",
					"e.g. http://localhost:20128"
				);
				if (!urlInput) return;
				const baseUrl = urlInput.trim().replace(/\/$/, "");

				// Warn if remote HTTP (sends API key in cleartext)
				if (!isLocalUrl(baseUrl)) {
					try {
						const parsed = new URL(baseUrl);
						if (parsed.protocol === "http:") {
							ctx.ui.notify(
								"Warning: OmniRoute URL is remote but uses HTTP. " +
								"Your API key will be sent in cleartext. Use HTTPS for remote connections.",
								"warning"
							);
						}
					} catch {}
				}

				// Test connectivity
				try {
					const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
					if (res.status === 401) {
						// 401 means server is reachable but requires auth — expected before entering API key
					} else if (!res.ok) {
						safeNotify(ctx, `OmniRoute unreachable at ${baseUrl} (${res.status})`, "error");
						return;
					}
				} catch (e: any) {
					safeNotify(ctx, `OmniRoute unreachable at ${baseUrl}: ${e.message}`, "error");
					return;
				}

				// Ask for API Key
				const apiKey = await ctx.ui.input(
					"OmniRoute API Key",
					"Enter your API key or press enter to leave blank"
				);
				if (apiKey === undefined) return;

				// Save configuration
				try {
					let config: any = {};
					try {
						config = JSON.parse(fs.readFileSync(path, "utf8"));
					} catch {}

					if (!config.providers) config.providers = {};
					config.providers.omni = {
						baseUrl,
						api: "openai-completions",
						apiKey: apiKey.trim(),
						models: [],
					};

					atomicWriteJson(path, config);

					OMNI_URL = baseUrl;
					DASHBOARD_URL = baseUrl;

					ctx.ui.notify(
						`✅ OmniRoute setup complete and saved to models.json\n\nRun /omni sync to pull models into the Ctrl+P picker.`,
						"info"
					);
				} catch (e: any) {
					safeNotify(ctx, `Failed to save to models.json: ${e.message}`, "error");
				}
				return;
			}

			// ──────────────── /omni dashboard ────────────────

			if (sub === "dashboard" || sub === "dash") {
				safeNotify(ctx, [
						`OmniRoute Dashboard: ${DASHBOARD_URL}`,
						"",
						"Open in your browser for:",
						"  • Create/edit combos with model reordering",
						"  • Provider OAuth re-authentication",
						"  • Add built-in provider accounts",
						"  • Model analytics & request metrics",
						"  • Request logs & debugging",
					].join("\n"),
					"info"
				);
				return;
			}

			// ──────────────── /omni limits ────────────────

			if (sub === "__disabled_limits__") {
				ctx.ui.notify(managementOnlyMessage("/omni limits"), "warning");
				return;
			}

			// ──────────────── Unknown ────────────────

			ctx.ui.notify(
				`Unknown: /omni ${sub}\n\nAvailable: sync, setup, dashboard`,
				"warning"
			);
		},
	});
}
