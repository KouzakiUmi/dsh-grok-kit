# dsh-grok-kit

[中文](README.md) · **English**

<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="dsh-grok-kit: Grok OAuth and fused search for DeepSeek Harness">
</p>

<p align="center">
  <a href="https://github.com/MaRi23333/dsh-grok-kit/actions/workflows/ci.yml"><img src="https://github.com/MaRi23333/dsh-grok-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/dsh-grok-kit"><img src="https://img.shields.io/npm/v/dsh-grok-kit.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-4d6bfe.svg" alt="Apache-2.0"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-4d6bfe" alt="DeepSeek Harness 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/status-unofficial%20community%20plugin-7c84a8" alt="Unofficial community plugin">
</p>

> Use Grok in DeepSeek Harness through OAuth, with fused web/X search in the main model turn, reasoning continuity across turns, Imagine image generation and editing, and an xAI-only proxy.

> [!IMPORTANT]
> **Unofficial project, trademark, and account-use notice**
>
> `dsh-grok-kit` is an independently developed, third-party community plugin for DeepSeek Harness. It is not an official product of, or representative of, xAI, X, DeepSeek, DeepSeek Harness, or their maintainers, and it does not claim product-specific permission, sponsorship, endorsement, or approval from them. Grok, xAI, X, DeepSeek, DeepSeek Harness, and related names and marks belong to their respective owners and are used only to identify compatible services accurately.
>
> OAuth availability may depend on subscription tier, region, xAI terms, account entitlement, rate limits, and future service changes. Users are responsible for confirming that their account and use are permitted. This project does not guarantee continued access or compatibility and does not provide xAI/Grok accounts, subscriptions, or official support.

## More than OAuth sign-in

`dsh-grok-kit` adds a separate `xai-oauth` route to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It does not require `XAI_API_KEY` or patch dsh source code. The point is not only to sign in, but to bring server-side search and the fields required for continuous reasoning into the main chat path.

- **Search in the main loop:** web and X lookup occurs inside grok-4.6's current Think turn, so reasoning can use newly found material immediately
- **Continuous multi-turn reasoning:** high effort is the default, with `reasoning.encrypted_content` preserved for the next turn
- **Sign-in stays in sync with Grok CLI:** the plugin shares and writes back `~/.grok/auth.json` instead of copying once and rotating refresh tokens separately
- **Imagine text-to-image and image-to-image:** `grok_imagine` and `grok_imagine_edit` (image-to-image, reusing the main OAuth session) are enabled by default, while non-chat models stay out of the conversation picker; generated and edited images are stored in the DSH attachment library preserving normalized metadata, rendered in session image cards with prompt and inputs, and support download and re-generation/editing

Supporting behavior includes an xAI-only proxy, forced refresh and one retry on chat 401, atomic credential writes, and diagnostic redaction.

## Search in the main model turn

The same model id does not guarantee the same experience across integrations. [xAI documents that `grok-4.6` is available in both Grok Build and the public API](https://docs.x.ai/build/overview); the important search difference is whether server-side tools share the main conversation request.

**Separate search** sends another model request to retrieve or summarize material before returning it to the main conversation. That path remains useful when explicit filters are needed, but adds another model round, and its search summary is not produced inside the current reply's Think turn.

**Main-turn search** follows [xAI's server-side Responses search pattern](https://docs.x.ai/developers/tools/web-search), placing `{type:web_search}` and `{type:x_search}` directly on the main grok-4.6 request. Lookup occurs inside Think, so the model can use newly found web and X material during the same reasoning turn. This path is off by default (since v0.1.8); enable it from Settings or config.

To let both search systems coexist, DSH's native `web_search` remains in the host tool list but is removed from an xAI payload with fused search enabled, preventing a server-tool name collision. Other model routes can continue using the host search tool normally.

> When main-turn search is on, the plugin strips xAI reject stubs such as `x_keyword_search` so DSH does not start another step and reprint the writeup. If those names still appear, treat them as a diagnostic path, not normal UI.

For domain, account, or date filters, use the standalone `grok_web_search` / `x_search` tools — the default path while `backendSearch` is off; enabling `backendSearch` turns this standalone path into the optional mode.

`statefulResponses` is off by default. When enabled, the plugin uses `store: true` and `previous_response_id` to continue the conversation, appending only new user messages. It does not continue a turn that used client tools such as bash, to avoid repeating an existing search answer. Continuing a conversation does not guarantee that all search material from the previous turn is cached.

## Interface and behavior

### Account, models, and proxy

<p align="center">
  <img src="assets/readme/settings.png" width="620" alt="dsh-grok-kit settings: Grok CLI sign-in, model selection, and xAI-only proxy">
</p>
<p align="center"><em>Settings reuses the Grok CLI login, exposes account-visible models, and optionally configures a proxy for xAI only. <code>127.0.0.1</code> in the example is a loopback proxy address.</em></p>

<br><br>

### Web search inside the main loop

<p align="center">
  <img src="assets/readme/main-loop-search.png" width="760" alt="Grok completes web search inside the same Think turn">
</p>
<p align="center"><em>No nested search-tool card is opened: web lookup occurs inside the same Think turn, and the material is used immediately by the current reply. The news content is illustrative UI data, not a factual reference.</em></p>

<br><br>

### Server-side X search calls

<p align="center">
  <img src="assets/readme/x-search.png" width="760" alt="xAI returns an X-search custom_tool_call before completing the answer">
</p>
<p align="center"><em>Current builds strip <code>x_keyword_search</code> reject stubs when main-turn search is on, so the normal path no longer forwards them to DSH. The screenshot is illustrative and does not mean those names still appear in the UI.</em></p>

## Install

Install the npm package into the Web profile:

```sh
dsh plugin --profile web add dsh-grok-kit
dsh web
```

You can also pin the exact 0.2.0 release:

```sh
dsh plugin --profile web add dsh-grok-kit@0.2.0
dsh web
```

If `dsh` is not on PATH, run the same CLI package through `npx` (pinned to the supported host version):

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-grok-kit
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

If this profile previously used the GitHub source, first try `dsh plugin --profile web add dsh-grok-kit@latest`. If the source does not switch, remove the old package and add it again.

**0.2.0** freezes support for DeepSeek Harness `0.2.0-rc.2` and `@earendil-works/pi-ai@0.87.1` (Node 22/24), dropping compatibility with the legacy 0.1 host line. Adds the image-to-image tool `grok_imagine_edit` and session image interaction cards, and refines sign-in refresh and error handling. See [CHANGELOG.md](CHANGELOG.md) for update notes.

For a reproducible Git install, the command below pins a reviewed commit. `github:MaRi23333/dsh-grok-kit` without a SHA follows `main` and is not a reproducible pin:

```sh
dsh plugin --profile web add github:MaRi23333/dsh-grok-kit#f82370b68bbdb2204e095257ecc551b9111d5831
```

The full SHA fixes the installed source; the npm form follows the stable `latest` release by default.

Open **Settings → xAI Grok**, finish sign-in, then choose `xai-oauth / grok-4.6` or another mainline Grok model currently visible to the account. A model already saved in dsh settings still takes precedence.

See [INSTALL.md](INSTALL.md) for installation, migration, removal, and troubleshooting details.

## Models and tools

- The picker shows only mainline Grok chat models; Imagine, video, embedding, build, and code variants are hidden
- The default grok-4.6 descriptor uses high reasoning and requests `reasoning.encrypted_content` so encrypted reasoning context can be carried into later turns
- `grok_imagine` (text-to-image) and `grok_imagine_edit` (image-to-image, reusing the main OAuth session) are enabled by default. Images are stored in the DSH attachment library and rendered directly in session image cards. Images can be downloaded from the card or exported with host file tools; direct disk writing via `save_path` is no longer supported for either tool
- DSH's native `web_search` remains in the host tool list, but is removed from an xAI payload with backend search enabled to avoid duplicate tool names

The model list comes from the signed-in account's `GET /v1/models` response and is cached locally. Service or model requirements may still require a plugin update; a visible model id does not imply that every capability is available to the account.

### Image inputs and iterative editing

- Local image paths: read boundedly via host filesystem (fs) services according to the host environment permissions, subject to single-image size caps. The execution card shows the path and an "open input image" entry; frontends cannot read arbitrary local paths directly.
- User-uploaded images: saved by DSH as session attachments. Pass the full `attachment={...}` reference provided by the host to `grok_imagine_edit.image`; the card loads thumbnails via session `readAttachment`.
- Iterative editing of generated images: tool results include an ImageBlock and the full `attachment={...}` payload. Pass the full reference as the next `image` parameter; the attachment service reads and verifies the saved image while preserving normalized metadata.
- Bare `attachmentId=sha256:...` handles are supported only when the host attachment library provides `imageHostPath`; remote attachment backends must use the full reference. Attachment IDs are not local file paths or URLs.
- Data URI inputs are validated for decoded byte size, base64 encoding, magic-byte signatures, and MIME consistency; remote URLs are fetched upstream, and the card displays links to avoid automatic browser requests to arbitrary addresses.
- Session card interactions: cards display the prompt and all input sources; completed runs show the result, a download entry, and a regenerate/re-edit action. Re-editing retains all input images and original render parameters.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `backendSearch` | `false` (off by default; enable from Settings) | Enable xAI server-side web/X search in the main chat request |
| `nestedSearchTools` | omitted: `!backendSearch` | Register separate `grok_web_search` / `x_search` tools |
| `statefulResponses` | omitted: `false` | Opt-in `store` + `previous_response_id`; `toolUse` turns are not continued |
| `searchModel` | `grok-build-0.1` | Model used by nested search mode |
| `searchMaxResults` | `8` | Maximum number of sources returned by nested search |
| `webSearchTimeoutMs` | `60000` | Cooperative budget for nested web search |
| `xSearchTimeoutMs` | `120000` | Cooperative budget for nested X search |
| `imagineTool` | `true` | Register `grok_imagine` (text-to-image) |
| `editTool` | `true` | Register `grok_imagine_edit` (image-to-image; independent of `imagineTool`, reusing the main OAuth session) |
| `editModel` | `''` | Pin the image-edit model; empty string follows live catalog (prefers `grok-imagine-image-2.0`, fallback `grok-imagine-image`) |
| `editMaxSourceImages` | `5` | Per-request source-image cap for `grok_imagine_edit` (plugin accepts up to 5) |
| `editMaxImageBytes` | `20971520` | Per-source byte cap for `grok_imagine_edit` (default 20 MiB) |
| `proxyUrl` | `''` | xAI-only HTTP/HTTPS proxy; the value saved in Settings wins |

The bundle defaults come from `cordis.patch.yml`. For a manually reduced or recomposed setup, inspect the final values with `dsh --profile web --dump-config`.

The “Search & feature options” card on Settings → xAI Grok can also override the search/feature keys above (restart to apply; untouched keys keep following the bundle defaults instead of being pinned). `proxyUrl` is the exception — it applies immediately on save.

## Sign-in document, proxy, and security boundaries

- The live store prefers `~/.grok/auth.json`, sharing the same xAI credential with Grok CLI in place; sign-in and refresh write back to that file instead of performing a one-time import, and signing out in Settings signs Grok CLI out too
- OAuth refresh tokens rotate; atomic writes, in-process coalescing, and compare-and-write prevent concurrent refreshes from overwriting one another
- Browser status routes, errors, and diagnostics do not return token values
- Proxy settings accept only `http://` or `https://` URLs without embedded credentials; legacy values containing userinfo are scrubbed and do not reach status responses or logs
- The xAI-only fetch hook is restored when the plugin is disposed and does not permanently change system or process environment variables
- On Windows, Node mode bits are not NTFS ACLs. Restrict the directory ACL yourself if the user profile or `$DSH_HOME` is stored in a shared location
- Writer lock and safety boundaries: Credential writes delegate to official `@deepseek-ai/dsh-atomic-write` (`$DSH_HOME/.xai-oauth-auth.json.lock`). On the same host and PID namespace, contenders use an exclusive claim file and double-checked record/PID inspection to automatically take over and reclaim locks left by proven exited processes; locks held by live PIDs, unverified permissions, malformed records, or empty files continue to wait and time out (fail-closed). The credential and lock directory must reside on a local filesystem within the same PID namespace; sharing the directory across hosts or container boundaries is prohibited (mismatched PID spaces can cause mutex failures and data corruption). Manually replacing credential or lock files while these processes are running can bypass these safeguards; stop all related processes before making such changes

## Compatibility and limitations

- Supported host matrix is frozen at: DeepSeek Harness `0.2.0-rc.2` + `@earendil-works/pi-ai@0.87.1` (Node 22/24). Compatibility with the legacy 0.1 host line is no longer claimed.
- Some subscription tiers may allow browser sign-in but return HTTP 403 for chat or server-side search; this is an entitlement/service-policy result, not necessarily an expired token
- HTTP 401 is retried once after serialized refresh; 403 is not treated as token expiry
- Running this bundle alongside another bundle that registers the same xAI OAuth route is unsupported; follow the migration steps in [INSTALL.md](INSTALL.md) and remove the conflicting bundle first
- Backend search is off by default and can be enabled from Settings or config; availability still depends on the account, selected model, and xAI's current service behavior
- Removing the plugin does not delete `~/.grok/auth.json`; sign out in Settings first if the local login should be removed

## Troubleshooting

**Startup or chat reports `timed out waiting for the writer lock`**: An abnormally terminated write left a lock file that was not automatically reclaimed (such as a lock held by an active process, a malformed lock, permission issues, or a leftover `.takeover-*` claim file). The plugin relies on the official protocol for exited-process recovery, but active and unverified locks are never blindly removed to avoid stealing an active writer's lock. To resolve manually:

1. Stop all DeepSeek Harness and Grok CLI processes, and confirm via system process list that no relevant background processes remain;
2. Once all processes are confirmed stopped, remove `.xai-oauth-auth.json.lock` and any leftover `.xai-oauth-auth.json.lock.takeover-*` claim files under `$DSH_HOME` (default `~/.dsh`);
3. `~/.grok/auth.json.lock` belongs to Grok CLI; delete it only after confirming Grok CLI is completely stopped;
4. Restart.

A failed startup catalog refresh (including the lock timeout above) never blocks chat: the plugin serves the cached model list and retries in the background with 5s / 30s / 120s backoff.

## Feedback workflow

Issues with bug reports or suggestions and pull requests with improvements are welcome. Users with an active SuperGrok / X Premium subscription can open an issue with the [live-testing template](https://github.com/MaRi23333/dsh-grok-kit/issues/new?template=live-testing.md), recording pass / fail / untested for chat, follow-up chat, tools, search, and Imagine, plus the plugin version, `dsh --version`, Node version, OS, subscription tier (exact official wording), test date, and minimal reproduction steps. Redact before submitting: no tokens, no `auth.json` contents, no account email, no session ids, no private filesystem paths, no private conversation content.

Search [existing issues](https://github.com/MaRi23333/dsh-grok-kit/issues) first; add results to a matching issue instead of opening a duplicate. Do not renew a subscription just to test, and partial results from a single session are still valuable.

## Development

```sh
npm ci
npm run check
dsh plugin --profile web add ./dsh-grok-kit
```

Routine development uses `npm ci` (or `npm install`) and `npm run check` for full typechecks, tests, and builds. Running `node scripts/link-host-deps.mjs` is optional when linking live host dependencies for local debugging, and is not mandatory to avoid modifying user profiles unintentionally.

CI runs frozen install, typecheck, tests, and build on Node.js 22 and 24, then confirms that the committed `lib/` matches the source build.

## License and attribution

[Apache-2.0](LICENSE). Some code derives from Apache-2.0-licensed `dsh-xai`; see [NOTICE](NOTICE). Special thanks to [KouzakiUmi](https://github.com/KouzakiUmi) for contributing image-to-image editing (`grok_imagine_edit`), session image interaction cards, and host-dependency stability and compatibility fixes.
