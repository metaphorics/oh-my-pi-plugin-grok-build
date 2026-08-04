# Changelog

## 0.1.7

- Changed manual code entry to appear alongside the browser step, racing the local callback the way the host's own paste-code providers do, instead of waiting out a 20-second callback window.

## 0.1.6

- Added a manual authorization-code prompt to login. It appears once the local callback port has clearly failed, so sign-in still completes when the browser cannot reach this machine.

## 0.1.5

- Fixed plugin startup on OMP 17.2.7 by registering the custom stream under a private API ID while keeping outbound requests on OpenAI Chat Completions.

## 0.1.4

- Changed manual OAuth input to redeem the pasted redirect URL or authorization code as an authorization code over PKCE, removing the host paste-code opt-in so no login path submits a redirect URL or code as a refresh token.

## 0.1.3

- Switched the transport to the built-in OpenAI Chat Completions API (`/v1/chat/completions`), removing the unmappable custom API name so the host no longer throws `Unhandled API in mapOptionsForApi`.

## 0.1.2

- Added multi-account regression coverage: per-account credential identity in the host store, and Authorization rotation through the auth-retry resolver during streaming.
- Documented multi-account login and host load-balancing semantics in the README.

## 0.1.1

- Changed xAI Grok Build login to start browser PKCE before offering manual refresh-token input through `/login <token>`.
- Fixed Responses streaming for runtime-discovered models whose custom API compatibility had not been materialized.

## 0.1.0

- Added the standalone xAI Grok Build provider extension.
- Added paste-first OAuth with browser PKCE fallback and token refresh.
- Added authoritative model discovery with curated Grok 4.5 and Grok Composer metadata.
- Added OpenAI Responses streaming with Grok Build request identity headers.
