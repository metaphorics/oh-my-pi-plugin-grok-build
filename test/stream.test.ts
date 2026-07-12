import { expect, test } from "bun:test";
import type { Api, Context, Effort, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { BASE_URL, CLIENT_IDENTIFIER, CLIENT_VERSION, TOKEN_AUTH, USER_AGENT } from "../src/constants.js";
import { streamGrokBuild } from "../src/stream.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MODEL = buildModel({
	api: "xai-grok-build-responses",
	provider: "xai-grok-build",
	id: "grok-4.5",
	name: "Grok 4.5",
	baseUrl: BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 500_000,
	compat: {
		reasoningEffortMap: { minimal: "low" },
		includeEncryptedReasoning: false,
		filterReasoningHistory: true,
		supportsImageDetailOriginal: false,
		omitReasoningEffort: false,
		supportsReasoningEffort: true,
	},
} as ModelSpec<Api>) as Model<Api>;
const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function completedSse(text: string): Response {
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", output_index: 0, part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", output_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

interface ResponsesRequestBody {
	model?: string;
	stream?: boolean;
	input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
	reasoning?: { effort?: string; summary?: string | null };
}

interface CapturedRequest {
	url: string;
	method: string | undefined;
	redirect: RequestRedirect | undefined;
	body: string;
	headers: Headers;
}

test("streaming delegates Responses events and preserves per-session request identity", async () => {
	expect(MODEL.compat).toBeUndefined();
	const captured: CapturedRequest[] = [];
	const fetchMock: FetchImpl = async (input, init) => {
		captured.push({
			url: String(input),
			method: init?.method,
			redirect: init?.redirect,
			body: typeof init?.body === "string" ? init.body : "",
			headers: new Headers(init?.headers),
		});
		return completedSse(captured.length === 1 ? "first" : "second");
	};
	const providerSessionState = new Map<string, ProviderSessionState>();

	const first = await streamGrokBuild(MODEL, CONTEXT, {
		apiKey: "oauth-access",
		fetch: fetchMock,
		providerSessionState,
		headers: { "X-Grok-Turn-Idx": "999", TraceParent: "caller-value" },
		reasoning: "high" as Effort,
	}).result();
	const second = await streamGrokBuild(MODEL, CONTEXT, {
		apiKey: "oauth-access",
		fetch: fetchMock,
		providerSessionState,
		promptCacheKey: "cache-conversation",
	}).result();

	expect(first.content.find(item => item.type === "text")?.text).toBe("first");
	expect(first.stopReason).not.toBe("error");
	expect(second.content.find(item => item.type === "text")?.text).toBe("second");
	expect(second.stopReason).not.toBe("error");

	const requestBody = JSON.parse(captured[0].body) as ResponsesRequestBody;
	expect(captured[0].url).toBe(`${BASE_URL}/responses`);
	expect(captured[0].method).toBe("POST");
	expect(captured[0].redirect).toBe("error");
	expect(requestBody.model).toBe(MODEL.id);
	expect(requestBody.stream).toBe(true);
	expect(requestBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
	expect(requestBody.reasoning).toEqual({ effort: "high" });

	const initial = captured[0].headers;
	expect(initial.get("Authorization")).toBe("Bearer oauth-access");
	expect(initial.get("User-Agent")).toBe(USER_AGENT);
	expect(initial.get("x-grok-client-identifier")).toBe(CLIENT_IDENTIFIER);
	expect(initial.get("x-grok-client-version")).toBe(CLIENT_VERSION);
	expect(initial.get("X-XAI-Token-Auth")).toBe(TOKEN_AUTH);
	expect(initial.get("x-grok-model-override")).toBe(MODEL.id);
	expect(initial.get("x-grok-agent-id")).toMatch(UUID_PATTERN);
	expect(initial.get("x-grok-session-id")).toMatch(UUID_PATTERN);
	expect(initial.get("x-grok-conv-id")).toBe(initial.get("x-grok-session-id"));
	expect(initial.get("x-grok-req-id")).toMatch(UUID_PATTERN);
	expect(initial.get("x-grok-turn-idx")).toBeNull();
	expect(initial.get("traceparent")).toBeNull();

	const next = captured[1].headers;
	expect(next.get("x-grok-agent-id")).toBe(initial.get("x-grok-agent-id"));
	expect(next.get("x-grok-session-id")).toBe(initial.get("x-grok-session-id"));
	expect(next.get("x-grok-conv-id")).toBe("cache-conversation");
	expect(next.get("x-grok-req-id")).not.toBe(initial.get("x-grok-req-id"));
	expect(next.get("x-grok-turn-idx")).toBe("1");
	expect(next.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("upstream HTTP failures end the stream as errors", async () => {
	const result = await streamGrokBuild(MODEL, CONTEXT, {
		apiKey: "oauth-access",
		fetch: async () => new Response("bad request", { status: 400 }),
	}).result();

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("400 bad request");
});

test("non-canonical base URLs fail before fetching", () => {
	let fetchCalls = 0;
	const fetchMock: FetchImpl = async () => {
		fetchCalls++;
		return completedSse("never");
	};

	expect(() => streamGrokBuild({ ...MODEL, baseUrl: "https://example.com/v1" }, CONTEXT, { fetch: fetchMock })).toThrow(
		AIError.ConfigurationError,
	);
	expect(fetchCalls).toBe(0);
});
