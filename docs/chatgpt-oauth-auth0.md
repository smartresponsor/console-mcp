# ChatGPT OAuth + Auth0

This repository uses Auth0 as the OAuth / OIDC issuer for the ChatGPT UI connector.

## Safe documented values

- Public origin: `https://console-mcp.smartresponsor.com`
- MCP endpoint: `https://console-mcp.smartresponsor.com/mcp`
- Auth0 issuer: `https://dev-zdyugcgamq4bca8f.us.auth0.com/`
- Audience / resource: `https://console-mcp.smartresponsor.com`
- Read scope: `console:read`
- Write scope: `console:write`
- Recommended base scopes: `openid profile email offline_access`
- Recommended default scopes to request: `console:read console:write`

## Auth0 dashboard setup

Create:

- API name: `console-mcp`
- API identifier / audience: `https://console-mcp.smartresponsor.com`
- Scope: `console:read`
- Scope: `console:write`

Create an application:

- Recommended type: `Single Page Application`
- Why: ChatGPT UI uses a public OAuth client pattern with PKCE

Configure the app with the callback URL that the ChatGPT UI connector provides.
If the UI asks for web origins or logout URLs, use the same ChatGPT UI origin it gives you.

## What the server expects

- issuer must end with exactly one trailing slash
- audience must equal `https://console-mcp.smartresponsor.com`
- token scopes must include `console:read` for read-only access
- token scopes should include `console:write` to surface and use canonical write tools such as `console.write.repo.patch.apply`

## Metadata endpoint

`GET https://console-mcp.smartresponsor.com/.well-known/oauth-protected-resource`

The endpoint is public and returns:

- `resource`
- `authorization_servers`
- `scopes_supported`
- `bearer_methods_supported`

## Troubleshooting

- If ChatGPT shows missing permissions, reconnect the connector and approve the requested scope again.
- If the connector still says permissions were not fully granted, confirm the Auth0 API exposes both `console:read` and `console:write` and that the app grants both.
- If you changed API permissions after a previous login, revoke the user's authorized application in Auth0 so the next reconnect is forced to mint a fresh grant. Auth0 documents this under `User Management > Users > Authorized Applications`.
- If the connector still reuses an old grant, revoke the refresh token or the underlying grant in Auth0, then reconnect the connector in ChatGPT and open a new chat.
- If issuer validation fails, verify the Auth0 issuer trailing slash and the JWKS URL.
- If the connector cannot find the metadata endpoint, confirm the tunnel is up and public DNS resolves.
