# Changelog

## 0.1.1

- Changed xAI Grok Build login to start browser PKCE before offering manual refresh-token input through `/login <token>`.
- Fixed Responses streaming for runtime-discovered models whose custom API compatibility had not been materialized.

## 0.1.0

- Added the standalone xAI Grok Build provider extension.
- Added paste-first OAuth with browser PKCE fallback and token refresh.
- Added authoritative model discovery with curated Grok 4.5 and Grok Composer metadata.
- Added OpenAI Responses streaming with Grok Build request identity headers.
