# oh-my-pi-plugin-grok-build

Standalone [oh-my-pi](https://github.com/can1357/oh-my-pi) extension for the xAI Grok Build subscription provider. It adds OAuth login, authoritative model discovery, and OpenAI Responses streaming with the request identity expected by Grok Build.

## Install

Install the npm package:

```sh
omp plugin install oh-my-pi-plugin-grok-build
```

Install with github:

```sh
omp plugin install https://github.com/metaphorics/oh-my-pi-plugin-grok-build
```

Link a local checkout:

```sh
omp plugin link /path/to/oh-my-pi-plugin-grok-build
```

Load the extension source for one invocation:

```sh
omp -e /path/to/oh-my-pi-plugin-grok-build/src/index.ts
```

## Login

1. Start `omp` with the extension installed or loaded.
2. Run `/login`.
3. Select **xAI Grok Build**.
4. Complete the browser PKCE flow using the opened browser or copyable authorization URL.
5. While the callback is pending, `/login <OAuth refresh token>` applies a refresh token directly as the manual fallback.

Credentials are stored and refreshed through omp's normal OAuth credential store.

## Multiple accounts

Run `/login` again and complete the flow with a different xAI account to add another. Accounts are keyed by the OAuth subject (`sub`): logging into the same account replaces its tokens; a different account is stored alongside.

Account selection and quota ranking are host-owned; this extension deliberately adds no plugin-side balancer. Each omp session sticks to one account via a consistent hash of the session id; without a session, selection round-robins. On 401 or usage-limit 429, the host retries by re-minting the same account's token, then switches the session to a sibling account automatically. Token refresh preserves account identity.

## Models

The offline seed contains:

- `grok-4.5`: text and image input, 500k context, reasoning effort support.
- `grok-composer-2.5-fast`: text input, 200k context, non-reasoning.

After login, the provider refreshes the model list from Grok Build. Server-advertised chat models remain authoritative; image, speech-to-text, and voice-only model IDs are excluded from the chat picker.

Select a model explicitly with:

```sh
omp --model xai-grok-build/grok-4.5
```

## Limitations

- Manual refresh-token input requires omp 16.4.6 or newer. Keep the terminal private while entering the token.
- A stock host cannot enforce OAuth-only credentials at the same core boundary as a built-in provider. A runtime `--api-key` override is therefore not blocked by this extension.
- Remote auth-broker callback-port forwarding is unavailable because `CALLBACK_PORTS` is core-owned. Browser login uses local callback port `8086`.
- The extension becomes inert when the host already provides `xai-grok-build`, avoiding duplicate provider registration.
- Marketplace installations do not load extension modules declared only through `package.json#omp.extensions`. Install from npm or use `omp plugin link` instead.

## Development

```sh
bun install
bun run typecheck
bun test ./test
```

All automated tests use mocked network responses. A live xAI authorization attempt is an optional publication smoke check because account authorization may be unavailable.

## License

MIT
