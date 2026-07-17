import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Api, Context, FetchImpl, Model, ProviderSessionState, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	BASE_URL,
	CLIENT_IDENTIFIER,
	CLIENT_VERSION,
	TOKEN_AUTH,
	USER_AGENT,
} from "./constants.js";

const IDENTITY_KEY = "xai-grok-build:identity";

/**
 * Appended to 402 bodies so the host auth-retry classifier
 * (USAGE_LIMIT_PATTERN in @oh-my-pi/pi-ai error/rate-limit.ts, which already
 * matches `insufficient.?balance` — the DeepSeek canonical phrase) routes the
 * failure into markUsageLimitReached → sibling-account rotation instead of a
 * hard error. The host does not recognize xAI's "usage balance exhausted"
 * phrasing or HTTP 402 as a usage limit. Remove once the host classifier does.
 */
const QUOTA_MARKER = "insufficient balance";
const QUOTA_MARKER_FIELD = "omp_quota_marker";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendQuotaMarker(message: string): string {
	return `${message} (${QUOTA_MARKER})`;
}

function addQuotaMarker(value: JsonValue): JsonValue {
	if (!isJsonObject(value)) return { value, message: QUOTA_MARKER };

	const error = value.error;
	if (isJsonObject(error) && typeof error.message === "string") {
		error.message = appendQuotaMarker(error.message);
		return value;
	}
	if (typeof error === "string") {
		value.error = appendQuotaMarker(error);
		return value;
	}
	if (typeof value.message === "string") {
		value.message = appendQuotaMarker(value.message);
		return value;
	}

	let markerField = QUOTA_MARKER_FIELD;
	while (Object.hasOwn(value, markerField)) markerField = `_${markerField}`;
	value[markerField] = QUOTA_MARKER;
	return value;
}

async function normalizeQuotaExhaustedResponse(response: Response): Promise<Response> {
	let text = "";
	try {
		text = await response.text();
	} catch {
		// A consumed or otherwise unreadable quota response still needs a classifiable body.
	}

	let body: string;
	let parsedJson = false;
	if (text) {
		try {
			const parsed = JSON.parse(text) as JsonValue;
			body = JSON.stringify(addQuotaMarker(parsed));
			parsedJson = true;
		} catch {
			body = appendQuotaMarker(text);
		}
	} else {
		body = QUOTA_MARKER;
	}

	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	headers.set("content-type", parsedJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

interface GrokBuildIdentityState extends ProviderSessionState {
	agentId: string;
	sessionId: string;
	nextTurnIndex: number;
}

function createTraceparent(): string {
	const traceId = crypto.randomUUID().replaceAll("-", "");
	const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
	return `00-${traceId}-${spanId}-01`;
}

export function streamGrokBuild(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	if (model.baseUrl !== BASE_URL) {
		throw new AIError.ConfigurationError(`xAI Grok Build requests require the canonical base URL ${BASE_URL}`);
	}

	const providerSessionState = options?.providerSessionState ?? new Map<string, ProviderSessionState>();
	let identity = providerSessionState.get(IDENTITY_KEY) as GrokBuildIdentityState | undefined;
	if (!identity) {
		identity = {
			agentId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			nextTurnIndex: 0,
			close() {},
		};
		providerSessionState.set(IDENTITY_KEY, identity);
	}
	const innerFetch: FetchImpl = options?.fetch ?? globalThis.fetch;
	const wrappedFetch: FetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.delete("x-grok-turn-idx");
		headers.delete("traceparent");
		headers.set("User-Agent", USER_AGENT);
		headers.set("x-grok-client-identifier", CLIENT_IDENTIFIER);
		headers.set("x-grok-client-version", CLIENT_VERSION);
		headers.set("X-XAI-Token-Auth", TOKEN_AUTH);
		headers.set("x-grok-model-override", model.id);
		headers.set("x-grok-agent-id", identity.agentId);
		headers.set("x-grok-session-id", identity.sessionId);
		headers.set("x-grok-conv-id", options?.promptCacheKey ?? identity.sessionId);
		headers.set("x-grok-req-id", crypto.randomUUID());
		const turnIndex = identity.nextTurnIndex++;
		if (turnIndex > 0) {
			headers.set("x-grok-turn-idx", String(turnIndex));
			headers.set("traceparent", createTraceparent());
		}
		const response = await innerFetch(input, { ...init, headers, redirect: "error" });
		if (response.status !== 402) return response;
		return normalizeQuotaExhaustedResponse(response);
	}, innerFetch.preconnect ? { preconnect: innerFetch.preconnect } : {});

	const responsesModel = buildModel({
		...model,
		api: "openai-responses",
		compat: model.compatConfig,
	} as ModelSpec<"openai-responses">) as Model<Api>;
	return streamSimple(responsesModel, context, {
		...options,
		providerSessionState,
		fetch: wrappedFetch,
		hideThinkingSummary: options?.reasoning === undefined ? options?.hideThinkingSummary : true,
	});
}
