import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Effort } from "@oh-my-pi/pi-ai";
import {
	BASE_URL,
	CLIENT_IDENTIFIER,
	CLIENT_VERSION,
	NON_CHAT_PREFIXES,
	TOKEN_AUTH,
	USER_AGENT,
} from "./constants.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const COMPAT_DEFAULTS = {
	reasoningEffortMap: { minimal: "low" },
	includeEncryptedReasoning: false,
	filterReasoningHistory: true,
	supportsImageDetailOriginal: false,
} as const;

export const CURATED_MODELS: readonly ProviderModelConfig[] = [
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 500_000,
		maxTokens: 500_000,
		thinking: {
			mode: "effort",
			efforts: ["minimal", "low", "medium", "high", "xhigh"] as Effort[],
			effortMap: { minimal: "low" },
		},
		compat: {
			...COMPAT_DEFAULTS,
			omitReasoningEffort: false,
			supportsReasoningEffort: true,
		},
	},
	{
		id: "grok-composer-2.5-fast",
		name: "Grok Composer 2.5 Fast",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 200_000,
		compat: {
			...COMPAT_DEFAULTS,
			omitReasoningEffort: true,
			supportsReasoningEffort: false,
		},
	},
];

function isRecord(value: object | null): value is Record<string, object | string | number | boolean | null> {
	return value !== null && !Array.isArray(value);
}

export async function fetchGrokBuildModels(apiKey: string | undefined): Promise<readonly ProviderModelConfig[]> {
	if (apiKey === undefined) return CURATED_MODELS;

	const response = await globalThis.fetch(`${BASE_URL}/models`, {
		redirect: "error",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": USER_AGENT,
			"x-grok-client-identifier": CLIENT_IDENTIFIER,
			"x-grok-client-version": CLIENT_VERSION,
			"X-XAI-Token-Auth": TOKEN_AUTH,
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`xAI Grok Build model discovery failed: status ${response.status}`);
	}

	let payload: object | null;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`xAI Grok Build model discovery returned invalid JSON: status ${response.status}`);
	}
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error(`xAI Grok Build model discovery returned malformed JSON: status ${response.status}`);
	}

	const curatedById = new Map(CURATED_MODELS.map(model => [model.id, model]));
	const models: ProviderModelConfig[] = [];
	for (const entry of payload.data) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const id = entry.id.trim();
		if (!id || NON_CHAT_PREFIXES.some(prefix => id.startsWith(prefix))) continue;
		const curated = curatedById.get(id);
		models.push(
			curated ?? {
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				cost: ZERO_COST,
				contextWindow: 128_000,
				maxTokens: 128_000,
				compat: { ...COMPAT_DEFAULTS, omitReasoningEffort: true },
			},
		);
	}
	return models;
}
