import * as AIError from "@oh-my-pi/pi-ai/error";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/oauth/callback-server";
import { generatePKCE } from "@oh-my-pi/pi-ai/oauth/pkce";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	CALLBACK_PORT,
	OAUTH_CLIENT_ID,
	OAUTH_DISCOVERY_URL,
	OAUTH_REFERRER,
	OAUTH_SCOPE,
	PROVIDER_ID,
} from "./constants.js";

const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const MANUAL_REFRESH_INSTRUCTIONS =
	"Manual fallback: run /login <OAuth refresh token>. This provider expects a refresh token, not a redirect URL.";

interface GrokBuildDiscovery {
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
}

type DiscoveryEndpoint = keyof GrokBuildDiscovery;
const BROWSER_ENDPOINTS: readonly DiscoveryEndpoint[] = [
	"authorization_endpoint",
	"token_endpoint",
	"userinfo_endpoint",
];

function isRecord(value: object | null): value is Record<string, object | string | number | boolean | null> {
	return value !== null && !Array.isArray(value);
}

function isAllowlistedOAuthErrorCode(value: object | string | number | boolean | null | undefined): value is string {
	return (
		value === "invalid_request" ||
		value === "invalid_client" ||
		value === "invalid_grant" ||
		value === "unauthorized_client" ||
		value === "unsupported_grant_type" ||
		value === "invalid_scope"
	);
}

function throwIfResponseCancelled(error: Error | undefined, signal?: AbortSignal): void {
	if (error instanceof AIError.LoginCancelledError) throw error;
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
}

async function readAllowlistedErrorCode(response: Response, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const payload: object | null = await response.json();
		return isRecord(payload) && isAllowlistedOAuthErrorCode(payload.error) ? payload.error : undefined;
	} catch (error) {
		throwIfResponseCancelled(error instanceof Error ? error : undefined, signal);
		// Never include untrusted token-response text in diagnostics.
		return undefined;
	}
}

function validateEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: PROVIDER_ID });
	}
	const host = parsed.hostname.toLowerCase();
	if (parsed.protocol !== "https:" || host !== "auth.x.ai") {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: PROVIDER_ID });
	}
	return url;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError();
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function discover(
	fetchImpl: FetchImpl,
	requiredEndpoints: readonly DiscoveryEndpoint[],
	signal?: AbortSignal,
): Promise<GrokBuildDiscovery> {
	let response: Response;
	try {
		const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
		response = await fetchImpl(OAUTH_DISCOVERY_URL, {
			method: "GET",
			redirect: "error",
			headers: { Accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "discovery", provider: PROVIDER_ID, cause: error },
		);
	}
	if (response.status !== 200) {
		throw new AIError.OAuthError(`xAI OIDC discovery returned status ${response.status}.`, {
			kind: "discovery",
			provider: PROVIDER_ID,
			status: response.status,
		});
	}
	let payload: object | null;
	try {
		payload = await response.json();
	} catch (error) {
		throwIfResponseCancelled(error instanceof Error ? error : undefined, signal);
		throw new AIError.OAuthError(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: PROVIDER_ID, cause: error },
		);
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("xAI OIDC discovery response was not a JSON object.", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const endpoints: GrokBuildDiscovery = {
		authorization_endpoint:
			typeof payload.authorization_endpoint === "string" ? payload.authorization_endpoint.trim() : "",
		token_endpoint: typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "",
		userinfo_endpoint: typeof payload.userinfo_endpoint === "string" ? payload.userinfo_endpoint.trim() : "",
	};
	for (const field of requiredEndpoints) {
		const endpoint = endpoints[field];
		if (!endpoint) {
			throw new AIError.OAuthError(`xAI OIDC discovery response was missing ${field}.`, {
				kind: "validation",
				provider: PROVIDER_ID,
			});
		}
		validateEndpoint(endpoint, field);
	}
	return endpoints;
}

function parseTokenResponse(payload: object | null, label: string, refreshFallback?: string): OAuthCredentials {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError(`${label} was not a JSON object`, { kind: "validation", provider: PROVIDER_ID });
	}
	const access = typeof payload.access_token === "string" ? payload.access_token : "";
	const rotatedRefresh = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
	const refresh = rotatedRefresh || refreshFallback || "";
	const expiresIn = payload.expires_in;
	if (!access) {
		throw new AIError.OAuthError(`${label} missing access_token`, { kind: "validation", provider: PROVIDER_ID });
	}
	if (!refresh) {
		throw new AIError.OAuthError(`${label} missing refresh_token`, { kind: "validation", provider: PROVIDER_ID });
	}
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
		throw new AIError.OAuthError(`${label} missing expires_in`, { kind: "validation", provider: PROVIDER_ID });
	}
	return {
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
	};
}

async function exchangeRefreshToken(
	tokenEndpoint: string,
	refreshToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!refreshToken.trim()) {
		throw new AIError.OAuthError("missing refresh_token", { kind: "validation", provider: PROVIDER_ID });
	}
	throwIfCancelled(signal);
	let response: Response;
	try {
		response = await fetchImpl(validateEndpoint(tokenEndpoint, "token_endpoint"), {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: OAUTH_CLIENT_ID,
				refresh_token: refreshToken,
			}),
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		if (error instanceof AIError.OAuthError) throw error;
		throw new AIError.OAuthError(
			`xAI token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "token-refresh", provider: PROVIDER_ID, cause: error },
		);
	}
	if (!response.ok) {
		const errorCode = await readAllowlistedErrorCode(response, signal);
		throw new AIError.OAuthError(
			`xAI token refresh failed: ${response.status}${errorCode ? ` ${errorCode}` : ""}`,
			{ kind: "token-refresh", provider: PROVIDER_ID, status: response.status },
		);
	}
	let payload: object | null;
	try {
		payload = await response.json();
	} catch (error) {
		throwIfResponseCancelled(error instanceof Error ? error : undefined, signal);
		throw new AIError.OAuthError("xAI token refresh returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER_ID,
			cause: error,
		});
	}
	return parseTokenResponse(payload, "xAI token refresh response", refreshToken);
}

async function attachUserInfo(
	credentials: OAuthCredentials,
	userinfoEndpoint: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	throwIfCancelled(signal);
	let response: Response;
	try {
		response = await fetchImpl(validateEndpoint(userinfoEndpoint, "userinfo_endpoint"), {
			headers: { Authorization: `Bearer ${credentials.access}`, Accept: "application/json" },
			redirect: "error",
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`xAI userinfo request failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "http", provider: PROVIDER_ID, cause: error },
		);
	}
	if (!response.ok) {
		throw new AIError.OAuthError(`xAI userinfo request failed: ${response.status}`, {
			kind: "http",
			provider: PROVIDER_ID,
			status: response.status,
		});
	}
	let payload: object | null;
	try {
		payload = await response.json();
	} catch (error) {
		throwIfResponseCancelled(error instanceof Error ? error : undefined, signal);
		throw new AIError.OAuthError("xAI userinfo response returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER_ID,
			cause: error,
		});
	}
	if (!isRecord(payload) || typeof payload.sub !== "string" || !payload.sub.trim()) {
		throw new AIError.OAuthError("xAI userinfo response missing sub", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const email = typeof payload.email === "string" && payload.email.trim() ? payload.email : undefined;
	return { ...credentials, accountId: payload.sub, ...(email ? { email } : {}) };
}

class GrokBuildOAuthFlow extends OAuthCallbackFlow {
	#discovery: GrokBuildDiscovery;
	#verifier: string;
	#challenge: string;
	#fetch: FetchImpl;
	#manualRefreshToken: { value?: string };

	constructor(
		callbacks: OAuthLoginCallbacks,
		discovery: GrokBuildDiscovery,
		pkce: { verifier: string; challenge: string },
		fetchImpl: FetchImpl,
	) {
		const manualRefreshToken: { value?: string } = {};
		const onManualCodeInput = callbacks.onManualCodeInput;
		super(
			onManualCodeInput
				? {
						...callbacks,
						onManualCodeInput: async () => {
							const input = (await onManualCodeInput()).trim();
							manualRefreshToken.value = input || undefined;
							return input ? "grok-build-refresh-token" : "";
						},
					}
				: callbacks,
			{
				preferredPort: CALLBACK_PORT,
				allowPortFallback: false,
				callbackHostname: "127.0.0.1",
				callbackPath: "/callback",
			},
		);
		this.#discovery = discovery;
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;
		this.#fetch = fetchImpl;
		this.#manualRefreshToken = manualRefreshToken;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: OAUTH_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: OAUTH_SCOPE,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
			nonce: crypto.randomUUID(),
			referrer: OAUTH_REFERRER,
		});
		return {
			url: `${this.#discovery.authorization_endpoint}?${params.toString()}`,
			instructions: MANUAL_REFRESH_INSTRUCTIONS,
		};
	}

	generateState(): string {
		return crypto.randomUUID();
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		throwIfCancelled(this.ctrl.signal);
		const manualRefreshToken = this.#manualRefreshToken.value;
		if (manualRefreshToken) {
			const credentials = await exchangeRefreshToken(
				this.#discovery.token_endpoint,
				manualRefreshToken,
				this.#fetch,
				this.ctrl.signal,
			);
			return attachUserInfo(credentials, this.#discovery.userinfo_endpoint, this.#fetch, this.ctrl.signal);
		}
		let response: Response;
		try {
			response = await this.#fetch(this.#discovery.token_endpoint, {
				method: "POST",
				redirect: "error",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: OAUTH_CLIENT_ID,
					code,
					code_verifier: this.#verifier,
					redirect_uri: redirectUri,
				}),
				signal: requestSignal(this.ctrl.signal),
			});
		} catch (error) {
			if (this.ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
			throw new AIError.OAuthError(
				`xAI authorization-code exchange failed: ${error instanceof Error ? error.message : String(error)}`,
				{ kind: "token-exchange", provider: PROVIDER_ID, cause: error },
			);
		}
		if (!response.ok) {
			const errorCode = await readAllowlistedErrorCode(response, this.ctrl.signal);
			throw new AIError.OAuthError(
				`xAI authorization-code exchange failed: ${response.status}${errorCode ? ` ${errorCode}` : ""}`,
				{
					kind: "token-exchange",
					provider: PROVIDER_ID,
					status: response.status,
				},
			);
		}
		let payload: object | null;
		try {
			payload = await response.json();
		} catch (error) {
			throwIfResponseCancelled(error instanceof Error ? error : undefined, this.ctrl.signal);
			throw new AIError.OAuthError("xAI authorization-code exchange returned invalid JSON", {
				kind: "validation",
				provider: PROVIDER_ID,
				cause: error,
			});
		}
		const credentials = parseTokenResponse(payload, "xAI authorization-code token response");
		return attachUserInfo(credentials, this.#discovery.userinfo_endpoint, this.#fetch, this.ctrl.signal);
	}
}

export async function loginGrokBuild(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const fetchImpl = callbacks.fetch ?? fetch;
	try {
		throwIfCancelled(callbacks.signal);
		const discovery = await discover(fetchImpl, BROWSER_ENDPOINTS, callbacks.signal);
		const pkce = await generatePKCE();
		throwIfCancelled(callbacks.signal);
		return await new GrokBuildOAuthFlow(callbacks, discovery, pkce, fetchImpl).login();
	} catch (error) {
		if (error instanceof AIError.OAuthError || error instanceof AIError.LoginCancelledError) throw error;
		if (error instanceof Error && error.name === "AbortError") throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(error instanceof Error ? error.message : String(error), {
			kind: error instanceof AIError.ConfigurationError ? "configuration" : "validation",
			provider: PROVIDER_ID,
			cause: error,
		});
	}
}

export async function refreshGrokBuildToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const discovery = await discover(fetch, ["token_endpoint"]);
	return exchangeRefreshToken(discovery.token_endpoint, credentials.refresh, fetch);
}
