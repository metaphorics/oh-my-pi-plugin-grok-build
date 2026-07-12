import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { OAUTH_CLIENT_ID, OAUTH_DISCOVERY_URL, OAUTH_REFERRER, OAUTH_SCOPE } from "../src/constants.js";
import { loginGrokBuild, refreshGrokBuildToken } from "../src/oauth.js";

const DISCOVERY = {
	authorization_endpoint: "https://auth.x.ai/authorize",
	token_endpoint: "https://auth.x.ai/token",
	userinfo_endpoint: "https://auth.x.ai/userinfo",
};


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ExtendedPrompt = OAuthPrompt & { allowEmpty?: boolean; secret?: boolean };

afterEach(() => mock.restore());

function installFetch(implementation: FetchImpl): void {
	const fetchImpl = Object.assign(implementation, { preconnect: globalThis.fetch.preconnect });
	spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
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

function tokenResponse(refresh?: string): Response {
	return Response.json({
		access_token: "access-token",
		...(refresh === undefined ? {} : { refresh_token: refresh }),
		expires_in: 3600,
	});
}

test.each([
	["rotated-refresh", "rotated-refresh"],
	[undefined, "pasted-refresh"],
] as const)("paste login preserves refresh rotation semantics", async (returnedRefresh, expectedRefresh) => {
	let prompt: ExtendedPrompt | undefined;
	let tokenForm: URLSearchParams | undefined;
	let discoveryRedirect: RequestRedirect | undefined;
	let tokenRedirect: RequestRedirect | undefined;
	let userinfoRedirect: RequestRedirect | undefined;
	let authCalls = 0;
	const callbacks: OAuthLoginCallbacks = {
		onAuth: () => authCalls++,
		onPrompt: async received => {
			prompt = received as ExtendedPrompt;
			return "  pasted-refresh  ";
		},
		fetch: async (input, init) => {
			const url = String(input);
			if (url === OAUTH_DISCOVERY_URL) {
				discoveryRedirect = init?.redirect;
				return Response.json(DISCOVERY);
			}
			if (url === DISCOVERY.token_endpoint) {
				tokenForm = new URLSearchParams(String(init?.body));
				tokenRedirect = init?.redirect;
				return tokenResponse(returnedRefresh);
			}
			if (url === DISCOVERY.userinfo_endpoint) {
				userinfoRedirect = init?.redirect;
				return Response.json({ sub: "account-123", email: "user@example.com" });
			}
			throw new Error(`unexpected URL ${url}`);
		},
	};

	const credentials = await loginGrokBuild(callbacks);
	expect(Object.fromEntries(tokenForm?.entries() ?? [])).toEqual({
		grant_type: "refresh_token",
		client_id: OAUTH_CLIENT_ID,
		refresh_token: "pasted-refresh",
	});
	expect(discoveryRedirect).toBe("error");
	expect(tokenRedirect).toBe("error");
	expect(userinfoRedirect).toBe("error");
	expect(credentials.refresh).toBe(expectedRefresh);
	expect(credentials.accountId).toBe("account-123");
	expect(credentials.email).toBe("user@example.com");
	expect(prompt?.allowEmpty).toBe(true);
	expect(prompt?.secret).toBe(true);
	expect(authCalls).toBe(0);
});

test("a generic prompt rejection completes browser PKCE with redirect-safe token exchange", async () => {
	let authorizationUrl = "";
	let callbackStatus: Promise<number> | undefined;
	let tokenForm: URLSearchParams | undefined;
	let tokenRedirect: RequestRedirect | undefined;
	const login = loginGrokBuild({
		onPrompt: async () => {
			throw new Error("prompting unavailable");
		},
		onAuth: info => {
			authorizationUrl = info.url;
			const state = new URL(info.url).searchParams.get("state");
			const callbackUrl = `http://127.0.0.1:8086/callback?code=browser-code&state=${state}`;
			callbackStatus = globalThis.fetch(callbackUrl).then(response => response.status);
		},
		fetch: async (input, init) => {
			const url = String(input);
			if (url === OAUTH_DISCOVERY_URL) return Response.json(DISCOVERY);
			if (url === DISCOVERY.token_endpoint) {
				tokenForm = new URLSearchParams(String(init?.body));
				tokenRedirect = init?.redirect;
				return tokenResponse("browser-refresh");
			}
			if (url === DISCOVERY.userinfo_endpoint) return Response.json({ sub: "browser-account" });
			throw new Error(`unexpected URL ${url}`);
		},
	});

	const credentials = await login;
	expect(await callbackStatus).toBe(200);
	const params = new URL(authorizationUrl).searchParams;
	expect([...params.keys()].sort()).toEqual(
		[
			"response_type",
			"client_id",
			"redirect_uri",
			"scope",
			"code_challenge",
			"code_challenge_method",
			"state",
			"nonce",
			"referrer",
		].sort(),
	);
	const verifier = tokenForm?.get("code_verifier") ?? "";
	const verifierHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const expectedChallenge = Buffer.from(verifierHash).toString("base64url");
	expect(params.get("response_type")).toBe("code");
	expect(params.get("redirect_uri")).toBe("http://127.0.0.1:8086/callback");
	expect(params.get("state")).toMatch(UUID_PATTERN);
	expect(params.get("nonce")).toMatch(UUID_PATTERN);
	expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
	expect(params.get("code_challenge")).toBe(expectedChallenge);
	expect(params.get("client_id")).toBe(OAUTH_CLIENT_ID);
	expect(params.get("scope")).toBe(OAUTH_SCOPE);
	expect(params.get("code_challenge_method")).toBe("S256");
	expect(params.get("referrer")).toBe(OAUTH_REFERRER);
	expect(Object.fromEntries(tokenForm?.entries() ?? [])).toEqual({
		grant_type: "authorization_code",
		client_id: OAUTH_CLIENT_ID,
		code: "browser-code",
		code_verifier: expect.any(String),
		redirect_uri: "http://127.0.0.1:8086/callback",
	});
	expect(tokenRedirect).toBe("error");
	expect(credentials.refresh).toBe("browser-refresh");
	expect(credentials.accountId).toBe("browser-account");
});

test("explicit login cancellation does not start discovery", async () => {
	let fetchCalls = 0;
	const callbacks: OAuthLoginCallbacks = {
		onAuth: () => {},
		onPrompt: async () => {
			throw new AIError.LoginCancelledError();
		},
		fetch: async () => {
			fetchCalls++;
			throw new Error("must not fetch");
		},
	};

	await expect(loginGrokBuild(callbacks)).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	expect(fetchCalls).toBe(0);
});

test("cancellation during discovery body decoding remains a login cancellation", async () => {
	const controller = new AbortController();
	const callbacks: OAuthLoginCallbacks = {
		signal: controller.signal,
		onAuth: () => {},
		onPrompt: async () => "",
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(stream) {
						controller.abort();
						stream.error(new DOMException("cancelled", "AbortError"));
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	};

	await expect(loginGrokBuild(callbacks)).rejects.toBeInstanceOf(AIError.LoginCancelledError);
});

test("a body AbortError without caller cancellation remains an OAuth failure", async () => {
	const callbacks: OAuthLoginCallbacks = {
		onAuth: () => {},
		onPrompt: async () => "",
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(stream) {
						stream.error(new DOMException("body timeout", "AbortError"));
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	};

	const error = await captureError(loginGrokBuild(callbacks));
	expect(error).toBeInstanceOf(AIError.OAuthError);
	expect(error).not.toBeInstanceOf(AIError.LoginCancelledError);
});

test("refresh failures expose only status and allowlisted OAuth code", async () => {
	const credentials: OAuthCredentials = { access: "old-access", refresh: "secret-refresh", expires: 0 };
	installFetch(async input => {
		const url = String(input);
		if (url === OAUTH_DISCOVERY_URL) return Response.json(DISCOVERY);
		if (url === DISCOVERY.token_endpoint) {
			return Response.json(
				{ error: "invalid_grant", error_description: "secret-refresh was rejected" },
				{ status: 400 },
			);
		}
		throw new Error(`unexpected URL ${url}`);
	});

	const error = await captureError(refreshGrokBuildToken(credentials));
	expect(error.message).toContain("400 invalid_grant");
	expect(error.message).not.toContain("was rejected");
	expect(error.message).not.toContain("secret-refresh");
});
