import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { OAUTH_CLIENT_ID, OAUTH_DISCOVERY_URL, OAUTH_REFERRER, OAUTH_SCOPE } from "../src/constants.js";
import { loginGrokBuild, refreshGrokBuildToken } from "../src/oauth.js";

const DISCOVERY = {
	authorization_endpoint: "https://auth.x.ai/authorize",
	token_endpoint: "https://auth.x.ai/token",
	userinfo_endpoint: "https://auth.x.ai/userinfo",
};


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
	{
		description: "redirect URL",
		buildInput: (state: string) => `http://127.0.0.1:8086/callback?code=manual-code&state=${state}`,
	},
	{ description: "bare authorization code", buildInput: () => "manual-code" },
])("manual $description input exchanges an authorization code over PKCE", async ({ buildInput }) => {
	let authorizationUrl = "";
	let discoveryRedirect: RequestRedirect | undefined;
	let tokenForm: URLSearchParams | undefined;
	let tokenRedirect: RequestRedirect | undefined;
	let userinfoRedirect: RequestRedirect | undefined;
	let promptCalls = 0;
	const callbacks: OAuthLoginCallbacks = {
		onAuth: info => {
			authorizationUrl = info.url;
		},
		onPrompt: async () => {
			promptCalls++;
			throw new Error("manual callback input must not prompt");
		},
		onManualCodeInput: async () => {
			// The host parses a pasted redirect URL or raw code into an authorization
			// code; the state must match the one embedded in the authorization URL.
			const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
			return buildInput(state);
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
				return tokenResponse("rotated-refresh");
			}
			if (url === DISCOVERY.userinfo_endpoint) {
				userinfoRedirect = init?.redirect;
				return Response.json({ sub: "manual-account", email: "user@example.com" });
			}
			throw new Error(`unexpected URL ${url}`);
		},
	};

	const credentials = await loginGrokBuild(callbacks);
	// A pasted redirect URL or code must be redeemed as an authorization code,
	// never submitted as a refresh_token.
	const params = new URL(authorizationUrl).searchParams;
	const verifier = tokenForm?.get("code_verifier") ?? "";
	const verifierHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const expectedChallenge = Buffer.from(verifierHash).toString("base64url");
	expect(params.get("code_challenge")).toBe(expectedChallenge);
	expect(params.get("code_challenge_method")).toBe("S256");
	expect(Object.fromEntries(tokenForm?.entries() ?? [])).toEqual({
		grant_type: "authorization_code",
		client_id: OAUTH_CLIENT_ID,
		code: "manual-code",
		code_verifier: expect.any(String),
		redirect_uri: "http://127.0.0.1:8086/callback",
	});
	expect(discoveryRedirect).toBe("error");
	expect(tokenRedirect).toBe("error");
	expect(userinfoRedirect).toBe("error");
	expect(credentials.refresh).toBe("rotated-refresh");
	expect(credentials.accountId).toBe("manual-account");
	expect(credentials.email).toBe("user@example.com");
	expect(promptCalls).toBe(0);
});

test("browser-first login offers the prompt but the callback wins", async () => {
	let authorizationUrl = "";
	let authInstructions: string | undefined;
	let promptCalls = 0;
	let callbackStatus: Promise<number> | undefined;
	let tokenForm: URLSearchParams | undefined;
	let tokenRedirect: RequestRedirect | undefined;
	const login = loginGrokBuild({
		onPrompt: async () => {
			promptCalls++;
			// Real UIs block on the prompt until the user answers; the callback
			// wins the race while this stays outstanding.
			return new Promise<string>(() => {});
		},
		onAuth: info => {
			authorizationUrl = info.url;
			authInstructions = info.instructions;
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
	expect(authInstructions).toBeUndefined();
	// The prompt is offered from the start, racing the loopback callback,
	// mirroring the host's own paste-code providers. The callback wins here.
	expect(promptCalls).toBe(1);
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

// End-to-end proof of the wiring: no host manual handler, no callback, and the
// login still finishes from the code the browser printed.
test("login completes from a pasted code when the callback never arrives", async () => {
	const code = "efar99baLu8zkDakrXoWTsZwgPoxZgekhGBT0iJDSo0OEJbxOgKNlOXOs3Q8qevxvhKkEgVhKk2hV3zxDUVhQw";
	let promptMessage = "";
	let tokenForm: URLSearchParams | undefined;
	const credentials = await loginGrokBuild({
		onAuth: () => {},
		onPrompt: async prompt => {
			promptMessage = prompt.message;
			return code;
		},
		fetch: async (input, init) => {
			const url = String(input);
			if (url === OAUTH_DISCOVERY_URL) return Response.json(DISCOVERY);
			if (url === DISCOVERY.token_endpoint) {
				tokenForm = new URLSearchParams(String(init?.body));
				return tokenResponse("pasted-refresh");
			}
			if (url === DISCOVERY.userinfo_endpoint) return Response.json({ sub: "pasted-account" });
			throw new Error(`unexpected URL ${url}`);
		},
	});

	expect(promptMessage).toContain("authorization code");
	expect(Object.fromEntries(tokenForm?.entries() ?? [])).toEqual({
		grant_type: "authorization_code",
		client_id: OAUTH_CLIENT_ID,
		code,
		code_verifier: expect.any(String),
		redirect_uri: "http://127.0.0.1:8086/callback",
	});
	expect(credentials.refresh).toBe("pasted-refresh");
	expect(credentials.accountId).toBe("pasted-account");
});

test("a pre-cancelled login does not start discovery", async () => {
	const controller = new AbortController();
	controller.abort();
	let fetchCalls = 0;
	const callbacks: OAuthLoginCallbacks = {
		signal: controller.signal,
		onAuth: () => {},
		onPrompt: async () => {
			throw new Error("cancelled login must not prompt");
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

test("background refresh exchanges the stored refresh token", async () => {
	let tokenForm: URLSearchParams | undefined;
	let tokenRedirect: RequestRedirect | undefined;
	installFetch(async (input, init) => {
		const url = String(input);
		if (url === OAUTH_DISCOVERY_URL) return Response.json(DISCOVERY);
		if (url === DISCOVERY.token_endpoint) {
			tokenForm = new URLSearchParams(String(init?.body));
			tokenRedirect = init?.redirect;
			return tokenResponse("rotated-refresh");
		}
		if (url === DISCOVERY.userinfo_endpoint) return Response.json({ sub: "refresh-account" });
		throw new Error(`unexpected URL ${url}`);
	});

	const credentials: OAuthCredentials = { access: "old-access", refresh: "stored-refresh", expires: 0 };
	const refreshed = await refreshGrokBuildToken(credentials);
	expect(Object.fromEntries(tokenForm?.entries() ?? [])).toEqual({
		grant_type: "refresh_token",
		client_id: OAUTH_CLIENT_ID,
		refresh_token: "stored-refresh",
	});
	expect(tokenRedirect).toBe("error");
	expect(refreshed.access).toBe("access-token");
	expect(refreshed.refresh).toBe("rotated-refresh");
});
