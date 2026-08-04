import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { BASE_URL, CUSTOM_API_ID, PROVIDER_ID, PROVIDER_LABEL } from "./constants.js";
import { fetchGrokBuildModels } from "./models.js";
import { loginGrokBuild, refreshGrokBuildToken } from "./oauth.js";
import { streamGrokBuild } from "./stream.js";

export default function grokBuildPlugin(pi: ExtensionAPI): void {
	if (getOAuthProviders().some(provider => provider.id === PROVIDER_ID)) {
		pi.logger.info("xai-grok-build already provided by host; extension inert");
		return;
	}
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		api: CUSTOM_API_ID,
		streamSimple: streamGrokBuild,
		oauth: {
			name: PROVIDER_LABEL,
			login: loginGrokBuild,
			refreshToken: refreshGrokBuildToken,
			getApiKey: credentials => credentials.access,
		},
		fetchDynamicModels: fetchGrokBuildModels,
	});
}
