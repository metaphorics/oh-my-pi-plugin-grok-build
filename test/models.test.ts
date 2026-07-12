import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	BASE_URL,
	CLIENT_IDENTIFIER,
	CLIENT_VERSION,
	TOKEN_AUTH,
	USER_AGENT,
} from "../src/constants.js";
import { CURATED_MODELS, fetchGrokBuildModels } from "../src/models.js";

afterEach(() => mock.restore());

function installFetch(implementation: FetchImpl) {
	const fetchImpl = Object.assign(implementation, { preconnect: globalThis.fetch.preconnect });
	return spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
}

async function captureError<T>(promise: Promise<T>): Promise<Error> {
	try {
		await promise;
	} catch (cause) {
		if (cause instanceof Error) return cause;
		throw cause;
	}
	throw new Error("expected promise to reject");
}

test("undefined credentials return the curated offline seed", async () => {
	const fetchSpy = installFetch(async () => {
		throw new Error("offline discovery must not fetch");
	});

	expect(await fetchGrokBuildModels(undefined)).toBe(CURATED_MODELS);
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("authenticated discovery overlays curated models and filters non-chat ids", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	installFetch(async (input, init) => {
		requestUrl = String(input);
		requestInit = init;
		return Response.json({
			data: [{ id: "grok-4.5" }, { id: "grok-future" }, { id: "grok-imagine-v1" }],
		});
	});

	const result = await fetchGrokBuildModels("access-token");
	const headers = new Headers(requestInit?.headers);
	expect(requestUrl).toBe(`${BASE_URL}/models`);
	expect(requestInit?.redirect).toBe("error");
	expect(headers.get("Authorization")).toBe("Bearer access-token");
	expect(headers.get("User-Agent")).toBe(USER_AGENT);
	expect(headers.get("x-grok-client-identifier")).toBe(CLIENT_IDENTIFIER);
	expect(headers.get("x-grok-client-version")).toBe(CLIENT_VERSION);
	expect(headers.get("X-XAI-Token-Auth")).toBe(TOKEN_AUTH);
	expect(result).toEqual([
		CURATED_MODELS[0],
		{
			id: "grok-future",
			name: "grok-future",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 128_000,
			compat: {
				reasoningEffortMap: { minimal: "low" },
				includeEncryptedReasoning: false,
				filterReasoningHistory: true,
				supportsImageDetailOriginal: false,
				omitReasoningEffort: true,
			},
		},
	]);
});

test("authenticated discovery errors expose status but never response bodies", async () => {
	installFetch(async () => new Response("secret response bytes", { status: 503 }));

	const error = await captureError(fetchGrokBuildModels("access-token"));
	expect(error.message).toContain("status 503");
	expect(error.message).not.toContain("secret response bytes");
});

test("malformed authenticated discovery is rejected", async () => {
	installFetch(async () => new Response("not-json", { status: 200 }));
	expect(fetchGrokBuildModels("access-token")).rejects.toThrow("invalid JSON");
});

test("an all-filtered response remains authoritatively empty", async () => {
	installFetch(async () =>
		Response.json({ data: [{ id: "grok-imagine-v1" }, { id: "grok-stt-1" }, { id: "grok-voice-live" }] }));

	expect(await fetchGrokBuildModels("access-token")).toEqual([]);
});
