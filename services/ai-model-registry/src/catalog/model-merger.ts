import {
    type PricedAiModel,
} from '@lixpi/usage-reporter'

import {
    type CatalogSchema,
} from './base-schema.ts'
import {
    type ProviderCatalogIndex,
} from './catalog-index.ts'
import { validateModel } from './model-validator.ts'
import {
    PROVIDER_DIRECTORIES,
    type Agreement,
    type AuthoredInferenceProviderValues,
    type ProviderDirectory,
    type DriftFinding,
    type FieldProvenance,
    type LixpiModelRecord,
    type MergeStatus,
    type MergedModel,
    type MergedModelFile,
    type ModelBundle,
    type ModelMetaFile,
    type InferenceProviderId,
    type MergedInferenceProvider,
    type SourceId,
    type SourceModelRecord,
} from './types.ts'
import {
    type CatalogBaseIndex,
} from './base-index.ts'
import { deriveShortTitle } from './short-title.ts'
import { familyId } from './model-identity.ts'

// Resolves one model from its source files, the provider's shared `base.json`, and
// its own authored file, and produces the merged record plus a full account of where
// every value came from.
//
// The authored file wins any field it states, and falls back to the provider base
// for the fields every model in a directory shares. A field it leaves out belongs to the
// sources, and among those the first source in precedence order that answered
// supplies the value. Where two sources disagree, both answers are kept and the
// field is marked. Where the authored file overrides a source, that is marked too
// and reported as drift, which is what turns the fetch into an alarm rather than a
// silent no-op.

// Rate leaves. One only transfers from a source when the units agree.
const RATE_KEYS = new Set([
    'prompt',
    'completion',
    'price',
    'withoutVideoInput',
    'withVideoInput',
])

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object'
    && value !== null
    && !Array.isArray(value)

// Arrays are leaves. A control list or an option list is one authored decision, and
// splicing two of them together would produce a configuration nobody wrote.
const flattenLeaves = (
    node: unknown,
    path: string[],
    out: Map<string, unknown>,
): void => {
    if (!isPlainObject(node)) {
        out.set(
            path.join('.'),
            node,
        )

        return
    }

    for (const [key, value] of Object.entries(node))
        flattenLeaves(
            value,
            [...path, key],
            out,
        )
}

const setPath = (
    target: Record<string, unknown>,
    path: string,
    value: unknown,
): void => {
    const segments = path.split('.')
    let cursor = target

    for (const segment of segments.slice(0, -1)) {
        if (!isPlainObject(cursor[segment]))
            cursor[segment] = {}

        cursor = cursor[segment] as Record<string, unknown>
    }

    cursor[segments.at(-1)!] = value
}

const getPath = (
    source: Record<string, unknown>,
    path: string,
): unknown => path.split('.').reduce<unknown>((cursor, segment) => (isPlainObject(cursor) ? cursor[segment] : undefined), source)

// A blank is a placeholder, not a value: it declares a field's shape and leaves the
// number to a source.
const isBlank = (value: unknown): boolean => value === ''
    || value === null

export class ModelMerger {
    constructor(private readonly schema: CatalogSchema) {}

    // A rate only transfers when both sides measure the same thing. Dollars per image
    // must never land in a field that means credits, which would be wrong by whatever
    // the two units differ by.
    private unitsAgree(
        path: string,
        lixpiLeaves: Map<string, unknown>,
        resolved: Map<string, unknown>,
    ): boolean {
        const bucket = path.split('.').slice(0, -1)
        const unitPath = [...bucket, 'measuringUnit'].join('.')
        const perPath = [...bucket, 'pricePer'].join('.')
        const lixpiUnit = lixpiLeaves.get(unitPath)
        const sourceUnit = resolved.get(unitPath)

        if (
            lixpiUnit === undefined
            || sourceUnit === undefined
        )
            return true

        return lixpiUnit === sourceUnit
            && lixpiLeaves.get(perPath) === resolved.get(perPath)
    }

    // One inference provider's own values: what the sources published for that
    // endpoint, and what the authored file states for it. Rates resolve only here,
    // because a price is a fact about an endpoint rather than about a model, so every
    // endpoint's rates survive the merge instead of the unused ones being dropped.
    private resolveOneProvider(
        covered: SourceModelRecord[],
        inferenceProvider: InferenceProviderId,
        order: SourceId[],
        baseIndex: CatalogBaseIndex,
        isCalledByThePlatform: boolean,
        authored: AuthoredInferenceProviderValues | undefined,
        provider: ProviderDirectory,
        modelId: string,
    ): {
        block: MergedInferenceProvider
        fields: Record<string, FieldProvenance>
        drift: DriftFinding[]
        authoredOnly: string[]
        overrides: string[]
        conflicts: string[]
        unitMismatches: string[]
        usedFallback: string[]
        missingRequired: string[]
    } {
        const bySourcePerField = new Map<string, Map<SourceId, unknown>>()
        const reportedBySources: SourceId[] = []
        const modelKeyAtSource: Partial<Record<SourceId, string>> = {}
        let providerReportedFacts: Record<string, unknown> | undefined

        for (const record of covered) {
            const facts = record.byInferenceProvider[inferenceProvider]

            if (!facts)
                continue

            const sourceName = record._meta.sourceId
            reportedBySources.push(sourceName)
            modelKeyAtSource[sourceName] = facts.modelKeyAtSource

            if (facts.sourceOnlyFacts) {
                providerReportedFacts = {
                    ...providerReportedFacts,
                    ...facts.sourceOnlyFacts,
                }
            }

            const {
                modelKeyAtSource: keyAtSource,
                sourceOnlyFacts,
                ...fields
            } = facts
            const leaves = new Map<string, unknown>()
            flattenLeaves(
                fields,
                [],
                leaves,
            )

            for (const [path, value] of leaves) {
                // Identity is the model's, not one endpoint's. It is resolved once at
                // the top level and repeating it here would suggest the endpoints
                // could disagree about which model this is.
                if (
                    path === 'model'
                    || path === 'modelVersion'
                )
                    continue

                const perSource = bySourcePerField.get(path) ?? new Map<SourceId, unknown>()

                if (!perSource.has(sourceName))
                    perSource.set(sourceName, value)

                bySourcePerField.set(path, perSource)
            }
        }

        // For Bedrock the AWS price list is the account's own bill, so it outranks an
        // aggregator's copy of the published rate. Everything else keeps the ordinary
        // source order.
        const winnerFor = (path: string): SourceId | undefined => {
            const perSource = bySourcePerField.get(path)

            if (!perSource)
                return undefined

            if (
                inferenceProvider === 'aws-bedrock'
                && path.startsWith('pricing')
                && perSource.has('bedrock')
            )
                return 'bedrock'

            return order.find(id => perSource.has(id))
        }

        const resolved = new Map<string, unknown>()

        for (const [path, perSource] of bySourcePerField)
            resolved.set(
                path,
                perSource.get(winnerFor(path)!),
            )

        const authoredLeaves = new Map<string, unknown>()
        flattenLeaves(
            authored ?? {},
            [],
            authoredLeaves,
        )

        // An endpoint nobody publishes for still gets an entry. Every provider that
        // can serve this model is listed whether or not a source covers it, so an
        // empty one reads as "nobody prices this here" instead of the endpoint
        // looking as though it does not exist.
        const values: Record<string, unknown> = {}
        const fields: Record<string, FieldProvenance> = {}
        const drift: DriftFinding[] = []
        const authoredOnly: string[] = []
        const overrides: string[] = []
        const conflicts: string[] = []
        const unitMismatches: string[] = []
        const usedFallback: string[] = []
        const missingRequired: string[] = []

        // The provenance path names the endpoint, because the same field on two
        // endpoints is two different facts.
        const provenancePath = (path: string): string => `inferenceProviders.${inferenceProvider}.${path}`

        const describe = (path: string): {
            agreement: Agreement
            answeredBy: SourceId[]
        } => {
            const perSource = bySourcePerField.get(path)

            if (!perSource)
                return {
                    agreement: 'only-one-source-answered',
                    answeredBy: [],
                }

            const distinct = new Set(
                [...perSource.values()].map(value => JSON.stringify(value)),
            )

            return {
                agreement: perSource.size === 1
                    ? 'only-one-source-answered'
                    : distinct.size === 1
                        ? 'all-sources-agree'
                        : 'sources-disagree',
                answeredBy: [...perSource.keys()] as SourceId[],
            }
        }

        const paths = new Set([
            ...authoredLeaves.keys(),
            ...resolved.keys(),
        ])

        for (const path of paths) {
            const authoredValue = authoredLeaves.get(path)
            const sourceValue = resolved.get(path)
            const stated = authoredLeaves.has(path) && !isBlank(authoredValue)
            const {
                agreement,
                answeredBy,
            } = describe(path)

            if (agreement === 'sources-disagree')
                conflicts.push(
                    provenancePath(path),
                )

            const keepAuthored = (): void => {
                fields[provenancePath(path)] = {
                    valueCameFrom: 'lixpi-authored-file',
                    sourceAgreement: agreement,
                    sourcesThatAnswered: answeredBy,
                    ...(stated
                        && sourceValue !== undefined
                        && JSON.stringify(sourceValue) !== JSON.stringify(authoredValue)
                        && { lixpiOverridesSource: true }),
                }
                setPath(
                    values,
                    path,
                    authoredValue,
                )
            }

            if (stated) {
                const overridesSource = sourceValue !== undefined
                    && JSON.stringify(sourceValue) !== JSON.stringify(authoredValue)

                if (overridesSource) {
                    overrides.push(
                        provenancePath(path),
                    )
                    drift.push({
                        provider,
                        modelId,
                        field: provenancePath(path),
                        lixpiValue: authoredValue,
                        fetchedValue: sourceValue,
                        source: agreement === 'sources-disagree'
                            ? `${winnerFor(path)} (sources differ)`
                            : String(
                                winnerFor(path),
                            ),
                        isPricing: path.startsWith('pricing'),
                    })
                } else if (sourceValue === undefined)
                    authoredOnly.push(
                        provenancePath(path),
                    )

                keepAuthored()

                continue
            }

            if (sourceValue === undefined) {
                keepAuthored()

                continue
            }

            // A rate only transfers when both sides measure the same thing. Dollars
            // per image must never land in a field that means credits.
            if (
                RATE_KEYS.has(path.split('.').at(-1)!)
                && authoredLeaves.has(path)
                && !this.unitsAgree(
                    path,
                    authoredLeaves,
                    resolved,
                )
            ) {
                unitMismatches.push(
                    provenancePath(path),
                )
                keepAuthored()

                continue
            }

            fields[provenancePath(path)] = {
                valueCameFrom: String(
                    winnerFor(path),
                ),
                sourceAgreement: agreement,
                sourcesThatAnswered: answeredBy,
            }
            setPath(
                values,
                path,
                sourceValue,
            )
        }

        // What the schema demands of an endpoint. Only the endpoint the platform is
        // calling has to satisfy it: an endpoint nobody prices is a gap in the
        // sources, not a broken model, and the model is still billable on the route
        // it actually runs on.
        for (const [name, field] of Object.entries(
            this.schema.inferenceProviderFields(),
        )) {
            const value = getPath(values, name)
            const empty = value === undefined
                || isBlank(value)
                || (Array.isArray(value) && value.length === 0)
                || (isPlainObject(value) && Object.keys(value).length === 0)

            if (!empty)
                continue

            if (field.defaultWhenNoSourceHasIt !== undefined) {
                // A default on an endpoint nobody covers would dress an empty block up
                // as a priced one, so it is only filled in where there is something to
                // qualify.
                if (
                    !isCalledByThePlatform
                    && Object.keys(values).length === 0
                )
                    continue

                setPath(
                    values,
                    name,
                    field.defaultWhenNoSourceHasIt,
                )

                if (
                    field.ownedBy === 'source'
                    && isCalledByThePlatform
                )
                    usedFallback.push(
                        provenancePath(name),
                    )

                continue
            }

            if (isCalledByThePlatform)
                missingRequired.push(
                    provenancePath(name),
                )
        }

        return {
            block: {
                inferenceProviderTitle: baseIndex.titleOf(inferenceProvider),
                isCalledByThePlatform,
                reportedBySources,
                modelKeyAtSource,
                ...values,
                ...(providerReportedFacts && { providerReportedFacts }),
            },
            fields,
            drift,
            authoredOnly,
            overrides,
            conflicts,
            unitMismatches,
            usedFallback,
            missingRequired,
        }
    }

    merge(
        bundle: ModelBundle,
        index: ProviderCatalogIndex,
        baseIndex: CatalogBaseIndex,
    ): MergedModel {
        const {
            provider,
            modelId,
        } = bundle

        // Every inference provider this model can be reached through, and the one the
        // platform is calling today. The top-level fields describe that call; each
        // provider's own values are kept beside them, because a rate Lixpi is not
        // billing on today is still a fact about the model and the flag that switches
        // between them changes nothing about the others.
        const inferenceProviders = baseIndex.providersFor(provider)
        const activeProvider = baseIndex.calledByThePlatformFor(provider)

        // What each source said for the provider being called, per leaf path. A source
        // file's `_meta` describes the fetch, not the model, so nothing in it is read
        // here and nothing from it reaches the merged record.
        const bySourcePerField = new Map<string, Map<string, unknown>>()
        const covered: SourceModelRecord[] = bundle.sources.filter(record => record._meta.hasDataForThisModel)
        const sourcesOnAnotherRoute: SourceId[] = []

        for (const record of covered) {
            const activeFacts = record.byInferenceProvider[activeProvider]

            if (!activeFacts)
                sourcesOnAnotherRoute.push(record._meta.sourceId)

            // A model's context window, output ceiling, and name are the same
            // whichever endpoint serves it, so those merge from any provider the
            // source knows. Taking them from the active one alone would throw away the
            // vendor API's limits for a model Lixpi calls through Bedrock. Rates are
            // the opposite and never merge here: they differ per endpoint and are
            // resolved inside each endpoint's own block.
            const claimed = new Set<string>()

            const collect = (facts: typeof activeFacts): void => {
                if (!facts)
                    return

                // Neither the source's own key for the model nor the facts it reports
                // outside the model record are values to merge.
                const {
                    modelKeyAtSource,
                    sourceOnlyFacts,
                    ...fields
                } = facts
                const leaves = new Map<string, unknown>()
                flattenLeaves(
                    fields,
                    [],
                    leaves,
                )

                for (const [path, value] of leaves) {
                    if (path.startsWith('pricing'))
                        continue

                    if (claimed.has(path))
                        continue

                    claimed.add(path)
                    const perSource = bySourcePerField.get(path) ?? new Map<string, unknown>()
                    perSource.set(record._meta.sourceId, value)
                    bySourcePerField.set(path, perSource)
                }
            }

            collect(activeFacts)

            for (const inferenceProvider of inferenceProviders) {
                if (inferenceProvider === activeProvider)
                    continue

                collect(record.byInferenceProvider[inferenceProvider])
            }
        }

        // Precedence is the order the source files were written in, which is the order
        // the fetcher consulted them. The one exception, the AWS price list winning
        // Bedrock's rates, lives in the per-endpoint resolution, because that is where
        // rates are decided.
        const order = bundle.sources.map(record => record._meta.sourceId)

        const winnerFor = (path: string): SourceId | undefined => order.find(id => bySourcePerField.get(path)?.has(id))

        const resolvedFromSources = new Map<string, unknown>()

        for (const [path, perSource] of bySourcePerField) {
            resolvedFromSources.set(
                path,
                perSource.get(winnerFor(path)!),
            )
        }

        // The authored per-endpoint block is resolved into the endpoint it names, not
        // onto the model, so it is held back from the top-level leaves. A rate stated
        // on the model itself is held back too and reported: it would be a price with
        // no endpoint attached, true for at most one of the endpoints serving it.
        const {
            byInferenceProvider: authoredByInferenceProvider,
            pricing: rateStatedOnTheModel,
            ...authoredModelFields
        } = bundle.lixpi as LixpiModelRecord & { pricing?: unknown }

        const modelLeaves = new Map<string, unknown>()
        flattenLeaves(
            authoredModelFields,
            [],
            modelLeaves,
        )

        const baseLeaves = new Map<string, unknown>()
        flattenLeaves(
            bundle.base?.fieldsInheritedByEveryModel ?? {},
            [],
            baseLeaves,
        )

        // The model's own file wins; the provider base fills what it leaves out.
        const lixpiLeaves = new Map<string, unknown>(baseLeaves)
        const inherited: string[] = []

        for (const [path, value] of baseLeaves) {
            const own = modelLeaves.get(path)

            if (
                own === undefined
                || isBlank(own)
            )
                inherited.push(path)
        }

        for (const [path, value] of modelLeaves) {
            if (
                isBlank(value)
                && baseLeaves.has(path)
            )
                continue

            lixpiLeaves.set(path, value)
        }

        let fields: Record<string, FieldProvenance> = {}
        const authored: string[] = []
        const overrides: string[] = []
        const conflicts: string[] = []
        const drift: DriftFinding[] = []
        const unitMismatches: string[] = []
        const values: Record<string, unknown> = {}

        // Who answered for a field and whether they agreed. Deliberately says nothing
        // about the values: those are in the merged file and in each source's file.
        const describe = (path: string): {
            agreement: Agreement
            answeredBy: SourceId[]
        } => {
            const perSource = bySourcePerField.get(path)

            if (!perSource)
                return {
                    agreement: 'only-one-source-answered',
                    answeredBy: [],
                }

            const distinct = new Set(
                [...perSource.values()].map(value => JSON.stringify(value)),
            )

            return {
                agreement: perSource.size === 1
                    ? 'only-one-source-answered'
                    : distinct.size === 1
                        ? 'all-sources-agree'
                        : 'sources-disagree',
                answeredBy: [...perSource.keys()] as SourceId[],
            }
        }

        const paths = new Set([
            ...lixpiLeaves.keys(),
            ...resolvedFromSources.keys(),
        ])

        for (const path of paths) {
            const lixpiValue = lixpiLeaves.get(path)
            const sourceValue = resolvedFromSources.get(path)
            const stated = lixpiLeaves.has(path) && !isBlank(lixpiValue)
            const {
                agreement,
                answeredBy,
            } = describe(path)

            if (agreement === 'sources-disagree')
                conflicts.push(path)

            const fromLixpi = inherited.includes(path)
                ? 'provider-base-file'
                : 'lixpi-authored-file'

            if (stated) {
                const overridesSource = sourceValue !== undefined
                    && JSON.stringify(sourceValue) !== JSON.stringify(lixpiValue)

                if (overridesSource)
                    overrides.push(path)
                else if (
                    sourceValue === undefined
                    && !inherited.includes(path)
                )
                    authored.push(path)

                if (overridesSource) {
                    drift.push({
                        provider,
                        modelId,
                        field: path,
                        lixpiValue,
                        fetchedValue: sourceValue,
                        source: agreement === 'sources-disagree'
                            ? `${winnerFor(path)} (sources differ)`
                            : String(
                                winnerFor(path),
                            ),
                        isPricing: path.startsWith('pricing'),
                    })
                }

                fields[path] = {
                    valueCameFrom: fromLixpi,
                    sourceAgreement: agreement,
                    sourcesThatAnswered: answeredBy,
                    ...(overridesSource && { lixpiOverridesSource: true }),
                }
                setPath(
                    values,
                    path,
                    lixpiValue,
                )

                continue
            }

            if (sourceValue === undefined) {
                fields[path] = {
                    valueCameFrom: fromLixpi,
                    sourceAgreement: agreement,
                    sourcesThatAnswered: answeredBy,
                }
                setPath(
                    values,
                    path,
                    lixpiValue,
                )

                continue
            }

            fields[path] = {
                valueCameFrom: String(
                    winnerFor(path),
                ),
                sourceAgreement: agreement,
                sourcesThatAnswered: answeredBy,
            }
            setPath(
                values,
                path,
                sourceValue,
            )
        }

        // Identity. The catalog entry is named for the model family; the id to call
        // is the current version the provider publishes, which the provider-api
        // record resolves. Without one, the authored file decides, and failing that
        // the family name is the id.
        const providerApi = bundle.sources.find(record => record._meta.sourceId === 'provider-api')
        const resolvedId = providerApi?._meta.publishedVersions?.currentVersion
            ?? (typeof bundle.lixpi.model === 'string' ? bundle.lixpi.model : null)
            ?? modelId

        values.provider = PROVIDER_DIRECTORIES[provider]
        values.model = resolvedId
        values.modelVersion = resolvedId

        // Every endpoint this model can be reached through, whether or not the
        // platform is calling it today. The top-level fields describe the current
        // call; these say what the same model costs and allows everywhere else.
        const perProvider: Partial<Record<InferenceProviderId, MergedInferenceProvider>> = {}
        const missingPerProvider: string[] = []
        const fallbackPerProvider: string[] = []

        for (const inferenceProvider of inferenceProviders) {
            const resolvedProvider = this.resolveOneProvider(
                covered,
                inferenceProvider,
                order,
                baseIndex,
                inferenceProvider === activeProvider,
                authoredByInferenceProvider?.[inferenceProvider],
                provider,
                modelId,
            )

            perProvider[inferenceProvider] = resolvedProvider.block
            fields = {
                ...fields,
                ...resolvedProvider.fields,
            }
            drift.push(...resolvedProvider.drift)
            authored.push(...resolvedProvider.authoredOnly)
            overrides.push(...resolvedProvider.overrides)
            conflicts.push(...resolvedProvider.conflicts)
            unitMismatches.push(...resolvedProvider.unitMismatches)
            fallbackPerProvider.push(...resolvedProvider.usedFallback)
            missingPerProvider.push(...resolvedProvider.missingRequired)
        }

        values.inferenceProviderCalledByThePlatform = activeProvider
        values.inferenceProviders = perProvider

        fields.provider = {
            valueCameFrom: 'derived-from-file-name',
            sourceAgreement: 'only-one-source-answered',
            sourcesThatAnswered: [],
        }

        for (const identity of ['model', 'modelVersion']) {
            fields[identity] = {
                valueCameFrom: providerApi?._meta.publishedVersions
                    ? 'provider-api'
                    : 'lixpi-authored-file',
                sourceAgreement: 'only-one-source-answered',
                sourcesThatAnswered: providerApi?._meta.publishedVersions ? ['provider-api'] : [],
            }
        }

        // The short title nobody has authored yet. It is derived from the title the
        // model already resolved to, so it is only available once the fields above
        // have merged, and the sync writes it back into the authored file where a
        // person can change it. An authored one is never touched.
        const authoredShortTitle = lixpiLeaves.get('shortTitle')
        const derivedShortTitle = isBlank(authoredShortTitle)
            || authoredShortTitle === undefined
            ? deriveShortTitle(
                typeof values.title === 'string' ? values.title : '',
                [
                    typeof values.providerTitle === 'string' ? values.providerTitle : '',
                    PROVIDER_DIRECTORIES[provider],
                    ...(bundle.base?.shortTitleDropsLeadingWords ?? []),
                ],
            )
            : null

        if (derivedShortTitle) {
            values.shortTitle = derivedShortTitle
            fields.shortTitle = {
                valueCameFrom: 'derived-from-title',
                sourceAgreement: 'only-one-source-answered',
                sourcesThatAnswered: [],
            }
        }

        const modalities = Array.isArray(values.modalities)
            ? (values.modalities as Array<{ modality?: string }>).map(entry => entry.modality ?? '')
            : []
        const expected = this.schema.fieldsForModalities(modalities)
        // A gap on the endpoint the platform calls is a gap in the model: it cannot be
        // billed on the route it runs on.
        const missingRequired: string[] = [...missingPerProvider]
        const usedFallback: string[] = [...fallbackPerProvider]

        for (const [name, field] of Object.entries(expected)) {
            const value = getPath(values, name)
            const empty = value === undefined
                || isBlank(value)
                || (Array.isArray(value) && value.length === 0)
                || (isPlainObject(value) && Object.keys(value).length === 0)

            if (!empty)
                continue

            if (field.defaultWhenNoSourceHasIt !== undefined) {
                setPath(
                    values,
                    name,
                    field.defaultWhenNoSourceHasIt,
                )

                // Only a source-owned field is worth reporting here. A Lixpi-owned
                // field with a standing default is not a gap in anyone's data.
                if (field.ownedBy === 'source')
                    usedFallback.push(name)

                continue
            }

            missingRequired.push(name)
        }

        const excluded = !index.includes(modelId)
        const status: MergeStatus = excluded
            ? 'skipped-by-catalog-index'
            : missingRequired.length > 0
                ? 'missing-required-fields'
                : 'written-to-database'

        const sourcesQueried = bundle.sources.map(record => record._meta.sourceId)
        const sourcesWithData = covered.map(record => record._meta.sourceId)

        const file: MergedModelFile = values as MergedModelFile

        const meta: ModelMetaFile = {
            modelFamily: familyId(modelId),
            mergedAt: new Date().toISOString(),
            baseSchemaVersion: this.schema.version,
            syncStatus: status,
            sources: {
                sourcesQueried,
                sourcesWithDataForThisModel: sourcesWithData,
                inferenceProviderCalledByThePlatform: activeProvider,
                sourcesWithoutRatesForThatProvider: sourcesOnAnotherRoute,
                confirmedByMoreThanOneSource: sourcesWithData.length > 1,
                fieldsWhereSourcesDisagree: conflicts,
            },
            lixpi: {
                fieldsOnlyLixpiSupplies: authored.sort(),
                fieldsWhereLixpiOverridesSources: overrides.sort(),
                fieldsInheritedFromProviderBaseFile: inherited.sort(),
            },
            requiredFieldsStillMissing: missingRequired,
            fieldsFilledFromSchemaDefault: usedFallback,
            ratesRefusedBecauseUnitsDiffer: unitMismatches,
            fieldOrigins: fields,
            ...(excluded && { note: `Skipped by catalog-settings.json: ${index.reasonFor(modelId)}` }),
            ...(status === 'missing-required-fields' && { note: 'Not written to the database: its authored fields are not filled in yet.' }),
            ...(sourcesWithData.length === 0 && { note: 'No source has data for this model. Every field comes from the authored file.' }),
            ...(rateStatedOnTheModel !== undefined && { note: `The authored file states a rate on the model itself, which was ignored: rates belong to one endpoint and go under byInferenceProvider.<${activeProvider}>.pricing.` }),
        }

        // Only a complete, included model becomes a catalog record. Anything else stays a
        // file on disk with its meta saying why.
        let model: PricedAiModel | null = null

        if (status === 'written-to-database') {
            const now = Date.now()
            model = validateModel({
                ...values,
                createdAt: now,
                updatedAt: now,
            } as unknown as PricedAiModel)
        }

        return {
            provider,
            modelId,
            file,
            meta,
            model,
            drift,
            ...(derivedShortTitle && { authoredFieldsToBackfill: { shortTitle: derivedShortTitle } }),
        }
    }
}
