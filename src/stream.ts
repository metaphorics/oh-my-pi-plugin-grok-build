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
		return innerFetch(input, { ...init, headers, redirect: "error" });
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
