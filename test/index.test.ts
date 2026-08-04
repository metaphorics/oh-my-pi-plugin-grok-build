import { expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { CUSTOM_API_ID, PROVIDER_ID } from "../src/constants.js";

interface ChildResult {
	initialCollision: boolean;
	registrationCount: number;
	registeredProvider: string | undefined;
	baseUrl: string | undefined;
	api: string | undefined;
	handlerIdentitiesMatch: boolean;
	customApiRegistered: boolean;
	apiKey: string | undefined;
	pasteCodeEnabled: boolean;
	collisionRegistrationCount: number;
	collisionLogs: string[];
}

const pluginUrl = new URL("../src/index.ts", import.meta.url).href;
const childScript = `
import plugin from ${JSON.stringify(pluginUrl)};
import { AuthStorage, PASTE_CODE_LOGIN_PROVIDERS, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { getOAuthProviders, registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASE_URL, CUSTOM_API_ID, PROVIDER_ID } from ${JSON.stringify(new URL("../src/constants.ts", import.meta.url).href)};
import { fetchGrokBuildModels } from ${JSON.stringify(new URL("../src/models.ts", import.meta.url).href)};
import { loginGrokBuild, refreshGrokBuildToken } from ${JSON.stringify(new URL("../src/oauth.ts", import.meta.url).href)};
import { streamGrokBuild } from ${JSON.stringify(new URL("../src/stream.ts", import.meta.url).href)};

const initialCollision = getOAuthProviders().some(provider => provider.id === PROVIDER_ID);
const authStorage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"));
await authStorage.reload();
const modelRegistry = new ModelRegistry(
  authStorage,
  join(tmpdir(), "grok-build-models-" + crypto.randomUUID() + ".yml"),
);
let registrationCount = 0;
let registeredProvider;
let config;
plugin({
  logger: { info() {} },
  registerProvider(provider, value) {
    registrationCount++;
    registeredProvider = provider;
    config = value;
    modelRegistry.registerProvider(provider, value, "grok-build-test");
  },
});
const handlerIdentitiesMatch = config !== undefined &&
  config.streamSimple === streamGrokBuild &&
  config.fetchDynamicModels === fetchGrokBuildModels &&
  config.oauth?.login === loginGrokBuild &&
  config.oauth?.refreshToken === refreshGrokBuildToken;
const customApiRegistered = getCustomApi(CUSTOM_API_ID)?.streamSimple === streamGrokBuild;
const apiKey = config?.oauth?.getApiKey({ access: "access-token", refresh: "refresh-token", expires: 1 });
const pasteCodeEnabled = PASTE_CODE_LOGIN_PROVIDERS.has(PROVIDER_ID);

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
authStorage.close();
process.stdout.write(JSON.stringify({
  initialCollision,
  registrationCount,
  registeredProvider,
  baseUrl: config?.baseUrl,
  api: config?.api,
  handlerIdentitiesMatch,
  customApiRegistered,
  apiKey,
  pasteCodeEnabled,
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
	expect(result.api).toBe(CUSTOM_API_ID);
	expect(result.handlerIdentitiesMatch).toBe(true);
	expect(result.customApiRegistered).toBe(true);
	expect(result.apiKey).toBe("access-token");
	expect(result.pasteCodeEnabled).toBe(false);
	expect(result.collisionRegistrationCount).toBe(0);
	expect(result.collisionLogs).toEqual(["xai-grok-build already provided by host; extension inert"]);
});
