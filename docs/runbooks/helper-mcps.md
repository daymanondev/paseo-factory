# Peer Helper MCP servers

Factory discovers Helper MCP definitions from Antigravity, Pi and Claude on the current host. Open **Plugins → Helper MCP Servers (Peer)** to inspect the merged catalog, enable or disable individual servers, and run **Test & Sync MCPs**. Duplicate Chrome DevTools and Z.ai packages and HTTP endpoint aliases share one entry. Source-disabled servers stay disabled until explicitly enabled here.

Helpers attach only to working Peers. Supervisor and Lead keep their Factory bridge; Lead receives a credential-free roster in its kickoff packet. Pi starts helper processes lazily. Peer can use all installed engineering skills except `factory`.

The status details distinguish local credential checks from live HTTP checks. Explicit HTTP probes have a three-second timeout; their results are cached for five minutes and invalidated when credentials or definitions change. Stdio checks verify command availability and required credentials without starting helper processes. `Auth Expired` and `Missing Key` need Owner attention before dispatching dependent work. Authenticate once in Antigravity or Pi, then sync again; Factory does not open an interactive login flow.

Before a managed Peer create, Factory asynchronously reconciles OAuth credentials and attempts refresh when expiry is within five minutes. Refresh requests have a five-second timeout. Failed refresh leaves the existing bundle available for diagnosis and reports expired authentication when appropriate. Live sessions are not reloaded by sync or toggle; their next create receives the updated configuration.

Private vault sync includes `config/helper-mcps.json` and `secrets/shared/mcp-oauth.json`. Environment values, headers, credential-bearing URLs and command arguments are separated into the secret bundle. Hydration preserves newer local OAuth tokens and restores Pi token files with mode `0600`. Vault encryption uses the vault's existing passphrase configuration.

Surface RPC names use Paseo's lowercase vocabulary: `factory.helper_mcps.sync_and_probe` and `factory.helper_mcps.set_enabled`. Their responses and snapshots contain names, sources, transport and health only, without server configuration or credentials.
