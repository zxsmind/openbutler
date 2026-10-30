# Providers, keys, models and reasoning

Contents: catalog, setup, endpoints, keys, retries, capabilities and diagnosis.
Related: [configuration](configuration.md), [web](web.md), [observability](observability.md).

## Discover current choices

```text
openbutler config
openbutler --list-models
openbutler --list-models --provider <id> --filter <text> --limit 50
openbutler keys list
```

Catalog data comes from models.dev with a twelve-hour cache and stale fallback
when offline. Runtime adapters are separate: common packages are bundled and
other supported packages may install in the data directory on first use. Catalog
presence does not prove endpoint reachability, account access, a key or an adapter.
Catalog capability flags do not filter provider/model lists or block model
selection. Actual tool support is determined by the endpoint. Discover exact ids
and capability data rather than treating an old model list as current.

Default model, configured active models and the full provider catalog are
different. Web Models manages the active list; selecting one determines a run's
model. `providerOrder` is not a fallback model chain.

One rule names a model on every surface (terminal, web, CLI): the operator's
explicit `modelSpecs.<model>.name`, then this provider's catalog name, then the
untouched model id. The id is never split, and a name recorded under another
provider is never guessed, so an id that contains a slash keeps it when nothing
knows the model. A provider shows its catalog display name, else its id.

## Add or edit a provider

Use `openbutler setup`, TUI `/provider` or Settings -> Providers. Setup supports a
catalog provider or custom id. A custom endpoint needs its runtime npm package,
base URL and model id. Runtime protocol matters: an OpenAI-compatible server and
an Anthropic server are not interchangeable. Preserve a required `/v1` prefix
without appending it twice.

Public shape, with placeholders and no credentials:

```yaml
providers:
  local-example:
    enabled: true
    npm: "@ai-sdk/openai-compatible"
    url: "http://127.0.0.1:8000/v1"
    models:
      - example-tool-model
providerOrder:
  - local-example
defaultProvider: local-example
defaultModel: example-tool-model
```

This shape does not establish that the endpoint exists. Establish URL, auth,
model id and tool/image compatibility first. A remote server is not reachable
through the OpenButler host's loopback address. After setup inspect the selected
model; merely adding a provider may not select the desired one.

## Keys and affinity

`openbutler keys add <provider>` uses masked input. `keys list` shows state, count and
redacted suffixes; `keys remove <provider>` removes keys while retaining the public
provider entry. Web Providers also supplies credential entry. MCP ids are not
provider ids; their credentials use the MCP environment-reference mechanism.

Keys are in the protected store, not command arguments or public YAML. A variable
set in a shell does not prove an already-running service sees it.

Default waits on one provider key are 1, 2, 4, 8, 16, 32, 32, 32 and 64 seconds:
nine waits, at most ten attempts. Classification distinguishes retryable network,
rate and provider errors from non-retryable failures. A retry notice does not by
itself indicate rotation. The next key is a later fallback after that key's budget.

Conversation `keyPositions` preserves the selected position for the provider/key
pool; resumed context does not automatically return to key A. Rotation does not
wrap. Changing the pool can invalidate a saved position. Prefix-cache affinity
can affect replay cost; inspect actual retry and usage records when diagnosing.

## Model selection and capabilities

TUI `/models` or the web composer selects configured models. Busy state can reject
an immediate change; web may display a pending choice until a safe point. Check
the settled provider/model. Effective limits include context/output, tool calling,
vision and model-specific reasoning variants. Catalog metadata and actual provider
acceptance are different evidence.

If a provider rejects image input, the runtime can disable image input and remove
unsupported image payloads while retaining text/archive. Inspect that error rather
than repeating the same unsupported request.

`/reasoning` chooses a supported variant; `/thinking` controls display. Web exposes
the equivalent model choice. A stale saved reasoning choice resolves to the
strongest supported level. No selectable level can be normal for that model.
Live preferences apply to subsequent steps/deltas. Hiding thinking does not prove
the provider stopped generating or billing reasoning. A separate reviewer model
is configured through [permissions](configuration.md).

## Verify and troubleshoot

| Symptom | Inspect |
| --- | --- |
| No selectable model | Enabled provider, active list and catalog/cache readiness |
| Auth rejected | Key/account status and server auth scheme |
| Model not found | Exact id and endpoint prefix |
| Rate-limit wait | Retry event, key position, provider limit and usage |
| Package load error | Adapter name, package installation and runtime log |
| Tools rejected | Server protocol and actual tool support |
| Context exceeded | Effective limit and compaction result |
| Reasoning ignored | Effective variant and provider/adapter support |

Listing/configuration is not a successful generation. A real request verifies
more but can consume paid tokens and execute enabled tools; keep any verification
bounded to the requested operation.
