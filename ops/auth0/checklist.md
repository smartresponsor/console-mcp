# Auth0 checklist

- [ ] Create API named `console-mcp`
- [ ] Set API identifier / audience to `https://console-mcp.smartresponsor.com`
- [ ] Add scope `console:read`
- [ ] Use `Single Page Application` for the ChatGPT connector app
- [ ] Enable code flow with PKCE
- [ ] Confirm issuer metadata is the Auth0 tenant issuer URL
- [ ] Confirm JWKS is available from issuer metadata
- [ ] Paste the ChatGPT UI callback URL into Auth0 when the connector presents it
- [ ] Add any requested web origins or logout URLs from ChatGPT UI
- [ ] Verify issued access tokens include `aud = https://console-mcp.smartresponsor.com`
- [ ] Verify issued tokens include `scope` containing `console:read`
