import { expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_ID } from "../src/constants.js";

interface ChildResult {
	initialCollision: boolean;
	registrationCount: number;
	registeredProvider: string | undefined;
	baseUrl: string | undefined;
	api: string | undefined;
	handlerIdentitiesMatch: boolean;
	apiKey: string | undefined;
	manualInputEnabled: boolean;
	collisionRegistrationCount: number;
	collisionLogs: string[];
}

const pluginUrl = new URL("../src/index.ts", import.meta.url).href;
const childScript = `
import plugin from ${JSON.stringify(pluginUrl)};
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthProviders, registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { BASE_URL, CUSTOM_API_ID, PROVIDER_ID } from ${JSON.stringify(new URL("../src/constants.ts", import.meta.url).href)};
import { fetchGrokBuildModels } from ${JSON.stringify(new URL("../src/models.ts", import.meta.url).href)};
import { loginGrokBuild, refreshGrokBuildToken } from ${JSON.stringify(new URL("../src/oauth.ts", import.meta.url).href)};
import { streamGrokBuild } from ${JSON.stringify(new URL("../src/stream.ts", import.meta.url).href)};

const initialCollision = getOAuthProviders().some(provider => provider.id === PROVIDER_ID);
let registrationCount = 0;
let registeredProvider;
let config;
plugin({
  logger: { info() {} },
  registerProvider(provider, value) {
    registrationCount++;
    registeredProvider = provider;
    config = value;
  },
});
const handlerIdentitiesMatch = config !== undefined &&
  config.streamSimple === streamGrokBuild &&
  config.fetchDynamicModels === fetchGrokBuildModels &&
  config.oauth?.login === loginGrokBuild &&
  config.oauth?.refreshToken === refreshGrokBuildToken;
const apiKey = config?.oauth?.getApiKey({ access: "access-token", refresh: "refresh-token", expires: 1 });
const manualInputEnabled = PASTE_CODE_LOGIN_PROVIDERS.has(PROVIDER_ID);

if (!initialCollision) {
  registerOAuthProvider({
    id: PROVIDER_ID,
    name: "collision stub",
    login: async () => "unused",
  });
}
let collisionRegistrationCount = 0;
const collisionLogs = [];
plugin({
  logger: { info(message) { collisionLogs.push(message); } },
  registerProvider() { collisionRegistrationCount++; },
});
process.stdout.write(JSON.stringify({
  initialCollision,
  registrationCount,
  registeredProvider,
  baseUrl: config?.baseUrl,
  api: config?.api,
  handlerIdentitiesMatch,
  apiKey,
  manualInputEnabled,
  collisionRegistrationCount,
  collisionLogs,
}));
`;

test("provider registration and collision behavior are correct in an isolated registry", async () => {
	const parentProviders = getOAuthProviders().map(provider => provider.id);
	const child = Bun.spawn([process.execPath, "--eval", childScript], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(getOAuthProviders().map(provider => provider.id)).toEqual(parentProviders);
	expect(exitCode, stderr).toBe(0);
	const result = JSON.parse(stdout) as ChildResult;
	expect(result.initialCollision).toBe(false);
	expect(result.registrationCount).toBe(1);
	expect(result.registeredProvider).toBe("xai-grok-build");
	expect(result.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
	expect(result.api).toBe("xai-grok-build-responses");
	expect(result.handlerIdentitiesMatch).toBe(true);
	expect(result.apiKey).toBe("access-token");
	expect(result.manualInputEnabled).toBe(true);
	expect(result.collisionRegistrationCount).toBe(0);
	expect(result.collisionLogs).toEqual(["xai-grok-build already provided by host; extension inert"]);
});
