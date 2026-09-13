# AI Model Registry

The AI Model Registry owns the models Lixpi ships and the generation parameters they accept, which values the code sends, and which settings appear in the model configuration matrix. It is both a browser tool for reviewing parameter decisions and the service that builds the model catalog and writes it to the `AI_MODELS_LIST` DynamoDB table the API reads.

The registry is an internal engineering service. It does not ship to users, but its data and the production model/provider code form one contract. Read [AI Model Registry](documentation/AI-MODEL-REGISTRY.md) before changing models, provider request fields, configuration controls, pricing, compatibility, or registry data. Read [Maintaining the Registry](documentation/MAINTAINING-THE-CATALOG.md) before a provider documentation refresh.

## Two trees

`data/params/` holds one JSON file per generation parameter, with provider documentation, model and API compatibility, implementation state, and the decision Lixpi made about it. That is what the browser UI edits.

`data/model-catalog/` holds the models:

```
catalog-settings.json               catalog-wide settings: the inference providers
schema.json                         fields every model carries, and who owns each
<provider>/
  base.json                         fields every model here inherits
  catalog-settings.json             which models sync, and which to skip
  <model>/
    litellm.json                    one file per source, always written
    models.dev.json                 records "no data" when the source has none
    provider-api.json               the vendor's own listing
    bedrock.json                    the AWS Bedrock catalog, where Lixpi routes through it
    lixpi.json                      authored: only what no source supplies
    merged.json                     the resolved model, values only
    _meta.json                      how that result was arrived at
```

One directory per model, so everything about a model sits together.

Every source gets a file for every model whether or not it had anything, so a gap reads as "this source has no data" rather than "this source was never asked".

The root `catalog-settings.json` holds what is true for the whole catalog rather than for one directory or one model. Today that is the inference providers: every endpoint Lixpi can send a generation request to, which catalog directories each one serves, the name a platform provider files those models under, and the environment flag that hands a directory to it. Adding a Bedrock-served vendor is a change to this file, not to code, and it moves together with `services/api/src/llm/providers/bedrock-inference.ts`, which is what can actually route the call.

`schema.json` declares what every model carries whatever its provider or modality, and who owns each field: `lixpi` for what no source can supply, `source` for what an aggregator publishes, `derived` for what the tree decides. Conditional groups add fields by modality. The merge reads it to know what to demand; the fetch reads it to scaffold a new model's authored file.

`base.json` holds what every model in a directory shares: the brand name, the colour, the icon names. Stated once and inherited, and overridden by any model that states its own. A scaffold leaves these out, so a new model's authored file shows only what still needs a decision.

A provider's own `catalog-settings.json` decides what syncs. `syncMode: "all"` takes everything discovered except `modelsToSkip`; `syncMode: "onlyListed"` takes only what `modelsToSync` names. A skipped model is never scaffolded, never fetched for, and never offered to DynamoDB, and the sync deletes its directory after copying it into `history/`. A provider whose file is missing or unreadable stops the run rather than falling back to syncing everything: the fallback would treat every model the provider lists as included and rebuild the tree the exclusions exist to keep out.

`_meta.json` is the account of the merge and holds no values of its own: which sources were consulted and which had data, whether the model is corroborated by more than one catalog, which fields the sources disagreed on, and which fields Lixpi authored, overrode, or inherited. Per field it names who supplied the value, who else answered, and whether they agreed. The values are in the merged file and in each source's file, which is where you compare them.

### One model, every endpoint that serves it

The same model reached through a vendor's own API and through AWS Bedrock is the same model at a different price: Claude Opus 5 is 5.00/25.00 per million from Anthropic and 5.50/27.50 in a Bedrock region. Both are recorded, for every provider that can serve the model, in every file.

A source file keys its answers under `byInferenceProvider`, and the merged file carries an `inferenceProviders` block with one entry per endpoint: what it costs there, the limits it carries there, the key each source files it under, and, for Bedrock, what it reports that no model field holds. `inferenceProviderCalledByThePlatform` names the one being called today, and the top-level fields describe everything about that call except its rates.

Rates are the exception because they are the one fact that is only ever true of an endpoint. There is no `pricing` on the model, and code that needs a rate reads the block for the endpoint the request goes to (`activeInferenceProviderPricing` in `@lixpi/constants`). A single rate on the model would be right for at most one of the endpoints serving it, and wrong money is worse than no money.

Switching the flag that chooses a provider therefore re-prices from data already in the tree and destroys nothing. An endpoint no source publishes for still gets an entry, so an empty one reads as "nobody prices this here" rather than the endpoint appearing not to exist. Only the endpoint the platform calls has to end up priced: a model nobody prices on the route it runs on is held out of the database, while a gap on an endpoint Lixpi is not calling is recorded and ignored.

The authored file holds what Lixpi owns and nothing else: capabilities, controls, modalities, icons, sort position, titles. Limits and prices are absent, because the sources publish them. An authored rate appears only as an override, and only when no source covers the field or a source measures it differently. It goes under `byInferenceProvider.<endpoint>.pricing`, the same key the source files use, so an override says which endpoint's price it is correcting. A `pricing` block on the model itself is ignored and the model's `_meta.json` says so.

It is edited through `PATCH /api/model-catalog/<provider>/models/<model>/lixpi`, which is what the catalog page's field form calls. The endpoint refuses a model the catalog has never discovered, keeps the previous version in `history/`, and reports which fields it actually changed. Editing the file by hand skips all of that.

### The short title nobody wrote yet

No source publishes a short title, so a newly discovered model has none and cannot reach the database without one. Rather than leaving a blank for someone to find, the merge derives one from the title and the sync writes it into the authored file through that same endpoint, where it shows up in the page and can be changed.

The default is the title with the provider's name removed, plus any leading brand word the directory's `base.json` lists in `shortTitleDropsLeadingWords`. Anthropic lists `Claude`, so "Claude Fable 5.1" becomes "Fable 5.1", matching the short titles authored there. Google lists nothing, so "Gemini 2.5 Pro" stays whole and "Google Veo 3.1" becomes "Veo 3.1". A short title that is already filled in is never touched, by this or by anything else in the sync.

### One entry per model family

Providers publish the same model twice, as a moving alias and the dated snapshots behind it. The catalog holds one entry per family, named without the snapshot suffix, and calls whichever version is current: the file is `dreamina-seedance-2-0-lixpi.json` and the `model` inside it is `dreamina-seedance-2-0-260128`. A version number that is part of the name is not a snapshot, so `gpt-5.5` and `claude-opus-4-6` keep theirs.

### Discovery and completeness

A model a provider lists gets an empty `-lixpi.json` scaffold with every Lixpi-owned field present and blank. It reaches DynamoDB only when the index includes it and every field the schema demands is filled in. Each merged file says which it is: `included`, `incomplete`, or `excluded`.

## The catalog sync

`src/catalog/` fetches, merges, reports, and writes.

Four sources are consulted for every model, in precedence order: LiteLLM, models.dev, the vendor's own listing endpoint, and the AWS Bedrock catalog. Both aggregators are fetched live.

Bedrock is a source in its own right rather than a substitute for the vendor API. An account can reach a model through both, and the two disagree usefully: Bedrock says what the account can actually invoke, while the vendor API publishes the token limits Bedrock does not carry. Both files are kept.

Three AWS calls back the Bedrock file. `ListFoundationModels` says what exists and what it can do, `ListInferenceProfiles` says how a model with no on-demand entry is called, and the AWS Price List Query API says what the account pays. The rates are the reason it is worth three calls: on the Bedrock route they are the bill, so on that route they win any pricing field they answer and the aggregators' copies of the public rate become the comparison rather than the value. Everything else about a Bedrock model keeps the ordinary source order.

Bedrock rates are spread over three service codes and reading only `AmazonBedrock`, which is what every AWS example does, finds nothing newer than Claude 3. `AmazonBedrockService` holds the current per-model token SKUs, and `AmazonBedrockFoundationModels` holds the marketplace products, which is where every current Claude model and every Stability endpoint is billed. All three are read.

Identifying the model is the hard half. AWS leaves the `model`, `feature`, and `inferenceType` attributes empty on recent SKUs, and it spells the model three ways depending on the SKU's age: `Claude3Haiku` on the old ones, `anthropic.claude-haiku-4-5-mantle` on the current ones, and nowhere at all on a marketplace SKU, where `USE1-MP:USE1_input_tokens_global_standard-Units` is Claude Opus 5 only because the product's `servicename` says so. All three are indexed, and the unit decides the scale: the ordinary SKUs price per thousand tokens and the marketplace ones per million.

Cache, batch, flex, priority, long-context, reserved-throughput, and custom-model SKUs are dropped. What is kept is the regional rate and the global-profile rate, which are genuinely different prices: Opus 5 is 5.50/27.50 per million regionally and 5.00/25.00 through a global profile. The one reported is the one the model is actually invoked at, decided by the id the source resolves for it, since a geo profile such as `us.anthropic.claude-opus-5` bills at the regional rate and only a `global.` profile gets the global one.

A price-list failure downgrades the source instead of stopping the run, because `pricing:GetProducts` is a separate permission from the Bedrock listing.

What Bedrock reports that no model field holds sits in `sourceOnlyFacts` on the route: the model ids behind the family, the id Lixpi would actually invoke and whether that is an inference profile, which price tier the rates were read from, the supported inference types and modalities, streaming support, the lifecycle status and end-of-life date, and every price-list tier with the usage types each rate came from. The merge ignores that block, so reading the file answers more than the merged record can carry.

Both aggregators publish rates for both endpoints, and they differ: Claude Haiku 4.5 is 1.00/5.00 per million direct against 1.10/5.50 in a Bedrock region. The `*_USE_AWS_BEDROCK_INFERENCE` flags decide which one the top-level fields describe, and the meta file names it. Only rates are endpoint-specific: limits and names merge from whichever endpoint a source knows. A source that reports a model on an endpoint `catalog-settings.json` does not list for that directory is ignored, which is how LiteLLM's Bedrock rates for OpenAI models stay out of a tree whose adapters cannot route them.

LiteLLM leads because it names each cost family separately, so an image model's image-token rate and its text rate are different fields. models.dev publishes one `cost` per model and cannot say which family it belongs to, so it only claims a rate when the model's output modalities make the family unambiguous. The provider endpoints answer what Lixpi's own account can reach, and they publish more than availability: Anthropic gives each model's display name and both token limits, Google gives the display name, both limits, and the default temperature. OpenAI's listing carries an id and a timestamp and nothing else.

### A run that loses a source is not a run

Any source that cannot answer fails the whole fetch. Not just a dead credential: a vendor listing that returns 500, a rate-limited key, a Bedrock call the account cannot make. The run collects every failure rather than stopping at the first, then raises before a single file is written or deleted, so the tree keeps exactly what the last complete run left.

That is the point of failing rather than continuing. A source that is broken and a source that has nothing to say look identical once written to disk, and continuing would silently reprice models onto whichever sources still answered.

An expired or missing AWS session goes through `err` and stops the run, naming the call that hit it, the profile, and the `aws sso login` command to fix it. The CLI exits with status 2.

Every run records its outcome in `data/_last-sync.json`, whether it finished or failed and which sources failed. The catalog page reads it and shows a banner naming each failed source and what it said, so a stale catalog announces itself instead of looking current.

Every source is recorded, including ones that had nothing. `_source.consulted` says who was asked, and `_source.fields` gives each field's value per source with an `agreement` of `single`, `identical`, or `differs`. Nothing looks corroborated when only one source carries it.

Where an authored value and a fetched value disagree, the merge keeps the authored one and reports the disagreement. Price disagreements are reported separately, because pricing reaches billing over the `metrics.*` wire and a wrong rate is a money bug rather than a display bug.

A run reports four things: `SOURCES DIFFER` where two catalogs disagree with each other, `PRICE DRIFT` where an authored rate disagrees with a source, `NO PRICE` and `NO SOURCE` for a blank nothing filled, and `UNIT MISMATCH` where a source has the value but measures it differently, which the merge refuses to convert.

Run one by hand inside the container:

```bash
docker compose exec -T lixpi-ai-model-registry \
  node --experimental-transform-types ./src/catalog/cli.ts --no-write
```

`--no-write` skips DynamoDB, `--no-fetch` merges the tree as it stands without asking any source. Over HTTP, `GET /api/models` returns the merged catalog, `GET /api/models/drift` returns the disagreements, and `POST /api/models/sync` runs one.

The scheduled loop is off unless `MODEL_CATALOG_SYNC_ENABLED=true`, so starting a container locally never writes DynamoDB on its own. On AWS the loop is on, the catalog tree ships read-only in the image, and each finished run publishes `aiModels.syncCompleted` with the run totals and drift counts. That NATS connection needs `NATS_AI_MODEL_REGISTRY_NKEY_SEED` here and the matching `NATS_AI_MODEL_REGISTRY_NKEY_PUBLIC` registered with the API's auth callout; without the seed the sync still runs and only the event is skipped.

## Running it

```bash
docker compose --profile dev --profile main up -d lixpi-ai-model-registry
```

Open http://localhost:3010. Stop it with `docker compose --profile dev --profile main stop lixpi-ai-model-registry`. The second profile makes the Compose project parse because `lixpi-dynamodb-admin` sits in the dev profile and depends on `lixpi-dynamodb` in main.

Node runs `src/server.ts` directly through `--experimental-transform-types`, so the server needs no build step. The TypeScript and SCSS client under `src/client` is served by Vite in development, and the deployed image builds it at container start through `pnpm run build-and-serve`, the same shape `services/api` and `services/web-ui` use.

The service hot reloads. Vite serves the page on 3010 and proxies `/api` to the Node server on 3011. `node --watch` restarts the API server when its sources change. Vite polls the bind-mounted source tree so atomic editor saves reach HMR.

`public/` is build output and is gitignored. Never edit it by hand. The deployed container has no Vite process; the Node server serves the compiled client and the API on port 3010.

Run the browser-client tests and service quality checks through the repository runners:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner ai-model-registry
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner ai-model-registry validate
```

## Pages

| URL | What it is |
|---|---|
| `/model-parameters` | The parameter registry: every generation parameter, its provider documentation, and the decision Lixpi made about it |
| `/model-catalog` | The model catalog: what the tree holds per model, how each one resolved, where the sources disagree with the authored file, and the controls that change it |

Any other path opens the parameter registry, which is where the service started. Both the Node server and Vite serve `index.html` for a path that is not a file, so a reload or a pasted link lands on the page it names.

The client uses [`@lixpi/web-client-service-factory`](../../packages/lixpi/web-client-service-factory/README.md) for application mounting, factory-owned routing, route-driven view replacement, base store creation, Vite configuration, and the Sass document foundation. It injects no browser runtime dependencies because this internal client does not authenticate users or connect to NATS. TypeScript DOM components use the `html` tagged template from `@lixpi/ui-primitives/dom`, and registry-specific Sass stays beside each component. The visual system comes from [`@lixpi/ui-kit-gentelella`](../../packages/lixpi/ui-kit-gentelella/README.md), which owns the [Gentelella](https://github.com/ColorlibHQ/gentelella) dependency, complete theme Sass, runtime facades, class contracts, and reusable DOM components.

```text
src/client/
    main.ts                 creates the shared client lifecycle and configures routing
    routes.ts               route paths, views, loaders, and navigation metadata
    sass/styles.scss        the theme
    services/               the model-catalog API client
    stores/                 model-catalog state built on the shared base store
    views/
        layouts/            sidebar, topbar, and shared route-view outlet
        modelParameters/    the parameter registry page
        modelCatalog/       the model catalog page
```

The catalog page reads `GET /api/model-catalog/overview`, which assembles each provider's index and inherited fields together with every model's resolved record, provenance, authored half, and drift. Opening a model reads `GET /api/model-catalog/<provider>/models/<model>/files`, which returns every JSON file in that model's directory with `merged.json` first, and the panel gives each one a tab. Its edits go to the same endpoints an engineer would call by hand: `PATCH /api/model-catalog/<provider>/models/<model>/lixpi` for the authored file, and `PATCH /api/model-catalog/<provider>/catalog-index` and `.../base` for the provider's configuration. Nothing in the browser writes a catalog file directly.

Excluded models show only under the status filter's "Excluded" option; every other status leaves them out. A skip takes effect the moment it is saved, but the model's directory survives until the next sync deletes it, so the rows would otherwise outnumber everything the catalog actually ships.

## Container-only administration

Registry data must be read and changed through commands that execute inside `lixpi-ai-model-registry`. Do not use host `curl`, `jq`, Node scripts, or direct writes to `data/params/`. The same rule covers `data/model-catalog/`, where the fetched `<model>.json` files belong to the sync and only the `-lixpi.json` beside them is hand-edited. The host command may start Docker Compose or enter the container, but the HTTP client, JSON processing, provider-document fetch, and registry mutation run inside the container.

The image includes `curl` and `jq`. A read uses this shape:

```bash
docker compose exec -T lixpi-ai-model-registry \
  curl -fsS http://127.0.0.1:3010/api/catalog
```

Existing parameter and group changes go through `PATCH /api/params`, which snapshots every affected file before writing. The browser uses `PUT /api/selections` for individual review decisions. [Maintaining the Registry](documentation/MAINTAINING-THE-CATALOG.md) contains the mutation commands and recovery rules.

## Deciding a parameter

Two checkboxes on the title row carry the decision:

| Use | Show in UI | Stored decision | Meaning |
|---|---|---|---|
| off | n/a | `skip` | Do not send this parameter. |
| on | off | `internal` | Send a fixed or derived value without a model-configuration control. |
| on | on | `expose` | Render a control in the model configuration matrix. |

Show in UI is disabled until Use is on because a control for a parameter nobody sends would do nothing.

Every row opens to match the implementation recorded in `currentState`: `exposed` means the matrix has a control, `hidden` means Lixpi sends a fixed or derived value, and `absent` means the provider request omits it.

The separate `reviewed` flag records whether a human confirmed the decision. Touching a row sets it, and the Unreviewed filter lists decisions that still need review.

Hide appears at the right of the title row once Use is off. It folds the row and mutes it for parameters that are out of scope. The note stays visible so the reason remains available. Ticking Use again clears the irrelevant state.

## Choosing a value

A parameter with a published value list uses selectable chips. Click one to select it and click it again to return to the provider default. Free-text parameters use a labelled input.

The selected value follows the decision. An `internal` row stores the value Lixpi sends. An `expose` row stores the control default. The server clears the field that does not apply, so a file never carries a value nothing uses.

The provider default has a cream dashed border and a default label. The Lixpi selection is green, including when Lixpi deliberately selects the provider default.

## Signing off

Three mutually exclusive statuses record what remains:

- Needs param clarification means the provider field is not understood well enough.
- Needs implementation investigation means the field is understood but its Lixpi wiring is not.
- Approved means the decision and implementation contract are settled. Approval is disabled while Use is off.

None of these statuses implies `reviewed`. Flagging a row for research is not the same as confirming its decision.

## Reading the badges

Already exposed means a matrix control exists. Sent but hidden means Lixpi sends the field without a user control. Never sent means it does not reach the provider.

A second badge appears only when the parameter needs care. Not on our models means the provider rejects it on that group's models. Verify first means the documentation and implementation disagree, or provider sources contradict each other, so the live API needs verification before a decision changes.

Parameters Lixpi sends carry a Used in this repo block naming the code path, where the value comes from, and what the provider receives.

## Registry layout

The directory layout is the registry structure. There is no separate database or hand-maintained index:

```text
data/params/
    _meta.json
    reasoning/
        _meta.json
        anthropic/
            _meta.json
            effort.json
            thinking.json
        google/
        openai/
    image/
    video/
```

Each parameter file carries documentation fields such as `apiField`, `type`, `values`, `range`, `providerDefault`, `currentState`, `availability`, `summary`, `combines`, and `usage`. The compatibility arrays are `supportedModels`, `unsupportedModels`, `supportedApis`, and `unsupportedApis`. Decision fields are `decision`, `reviewed`, `status`, `irrelevant`, `fixedValue`, `defaultValue`, and `note`.

The compatibility arrays drive the model filter and the support pills on each card. Models and API surfaces are independent axes. A Vertex-only field may be supported by every Veo model while remaining unavailable on the Gemini Developer API used by Lixpi.

## Write paths

`PUT /api/selections` is the browser path. It rewrites only decision fields that changed. It refuses a save carrying fewer reviewed decisions than the registry already holds and accepts `?snapshot=1` for programmatic use.

`PATCH /api/params` is the documented engineering path for existing registry entities. It updates parameter documentation and decision fields plus an existing group's `title`, `models`, and `docs`. It merges only supplied fields, rejects unknown targets and fields, and snapshots every affected file into `data/history/params-<timestamp>/` before writing.

The API does not create, rename, or delete parameter identities. Do not bypass that rule with a direct file write. If a provider introduces a genuinely new parameter or group, add a validated API operation for that identity change first, then invoke it inside the container. Retire an existing parameter by marking it unsupported instead of deleting it.

## Keeping code and registry data synchronized

A registry change is incomplete until the matching model sync profile, provider adapter, configuration matrix, UI control, tests, and developer documentation agree with it. A code change is incomplete until the registry records the same models, defaults, options, compatibility, exposure decision, and usage path.

The auto-discovered `ai-model-registry` skill enforces this contract for Codex, Claude Code, Cursor, and GitHub Copilot. The authoritative workflow is [AI Model Registry](documentation/AI-MODEL-REGISTRY.md).
