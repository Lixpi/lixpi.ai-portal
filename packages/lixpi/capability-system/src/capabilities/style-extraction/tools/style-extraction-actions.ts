import {
    type CapabilityActionExecutionContext,
    type CapabilityActionRegistry,
    type CapabilityActionValidationResult,
} from '../../../backend/capability-action-registry.ts'
import { CapabilityError } from '../../../shared/capability-errors.ts'
import {
    STYLE_EXTRACTION_AXES,
    STYLE_EXTRACTION_CAPABILITY_IDS,
} from './style-extraction-definition.ts'
import { styleExtractionSettings } from '../settings.ts'

export type StyleExtractionRuntimeState = {
    input: Record<string, unknown>
    references: unknown[]
    axisExtractions: Record<string, unknown>
    failedAxes: unknown[]
    sourceCrops: unknown[]
    samples: unknown[]
    [key: string]: unknown
}

type RuntimeStageInput = {
    state: StyleExtractionRuntimeState
    context: CapabilityActionExecutionContext
}

export type StyleExtractionRuntimePort = {
    initialize: (
        input: Readonly<Record<string, unknown>>,
        context: CapabilityActionExecutionContext,
    ) => Promise<StyleExtractionRuntimeState>
    route: (input: RuntimeStageInput) => Promise<{
        update: Partial<StyleExtractionRuntimeState>
        applicableAxes: string[]
    }>
    extractAxis: (input: RuntimeStageInput & { axis: string }) => Promise<{
        axisExtractions: Record<string, unknown>
        failedAxes: unknown[]
    }>
    materializeSourceCrops: (input: RuntimeStageInput) => Promise<Partial<StyleExtractionRuntimeState>>
    synthesizeStyle: (input: RuntimeStageInput) => Promise<Partial<StyleExtractionRuntimeState>>
    generateSamples: (input: RuntimeStageInput) => Promise<Partial<StyleExtractionRuntimeState>>
    persistStyle: (input: RuntimeStageInput & { allowedActionKeys: ReadonlySet<string> }) => Promise<Partial<StyleExtractionRuntimeState>>
}

export type StyleExtractionActionDependencies = {
    runtime: StyleExtractionRuntimePort
    extractorConcurrency?: number
}

export const registerStyleExtractionActions = (
    registry: CapabilityActionRegistry,
    dependencies: StyleExtractionActionDependencies,
): void => {
    const extractorLimiter = new ActionConcurrencyLimiter(dependencies.extractorConcurrency ?? 4)
    registerIfMissing(
        registry,
        {
            key: 'style.initialize',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.initialize,
            validateInput: validateObject,
            validateOutput: validateStateOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) => ({
                state: await dependencies.runtime.initialize(input, context),
            }),
            classifyRetry: () => 'terminal',
            summarizeInput: input => `sourceAssets=${arrayLength(input.sourceAssetIds)}`,
            summarizeOutput: output => `references=${arrayLength(asRecord(asRecord(output)?.state)?.references)}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.route',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.route,
            validateInput: validateStateInput,
            validateOutput: validateStateOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) => {
                const state = readState(input.state)
                requireInstructions(input.instructions, 'router instructions')
                const routed = await dependencies.runtime.route({
                    state,
                    context,
                })
                const routedState = mergeCopy(state, routed.update)
                const applicableAxes = new Set(routed.applicableAxes)

                return {
                    state: routedState,
                    applicableAxes: Object.fromEntries(
                        STYLE_EXTRACTION_AXES.map(axis => [axis, applicableAxes.has(axis)]),
                    ),
                }
            },
            classifyRetry: classifyProviderRetry,
            summarizeInput: input => `references=${arrayLength(asRecord(input.state)?.references)}`,
            summarizeOutput: output => `scene=${String(
                Boolean(asRecord(asRecord(output)?.state)?.sceneAssessment),
            )}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.extract-axis',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.extractAxis,
            validateInput: validateAxisInput,
            validateOutput: validateAxisOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) => {
                const state = readState(input.state)
                requireInstructions(input.instructions, 'axis extraction instructions')

                return await extractorLimiter.run(
                    context.signal,
                    async () =>
                        await dependencies.runtime.extractAxis({
                            state,
                            axis: readString(input.axis, 'axis'),
                            context,
                        }),
                )
            },
            classifyRetry: () => 'terminal',
            summarizeInput: input => `axis=${String(input.axis ?? '')}`,
            summarizeOutput: output => `extracted=${Object.keys(asRecord(output)?.axisExtractions ?? {}).length} failed=${arrayLength(
                asRecord(output)?.failedAxes,
            )}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.materialize-crops',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.materializeCrops,
            validateInput: validateStateInput,
            validateOutput: validateCropsOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) =>
                await dependencies.runtime.materializeSourceCrops({
                    state: readState(input.state),
                    context,
                }),
            classifyRetry: () => 'terminal',
            summarizeInput: input => `references=${arrayLength(asRecord(input.state)?.references)}`,
            summarizeOutput: output => `crops=${arrayLength(asRecord(output)?.sourceCrops)}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.merge-analysis',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.mergeAnalysis,
            validateInput: validateMergeInput,
            validateOutput: validateStateOutput,
            authorize: authorizeStyleExtraction,
            execute: input => {
                const state = structuredClone(
                    readState(input.state),
                )
                const crops = asRecord(input.crops)

                if (crops)
                    mergeState(state, crops)

                const axes = Object
                    .entries(input)
                    .filter(([key]) => key.startsWith('axis'))
                    .map(([, value]) => value)

                for (const axis of axes) {
                    const update = asRecord(axis)

                    if (!update)
                        continue

                    const axisExtractions = asRecord(update.axisExtractions)

                    if (axisExtractions)
                        state.axisExtractions = {
                            ...state.axisExtractions,
                            ...axisExtractions,
                        }

                    if (Array.isArray(update.failedAxes))
                        state.failedAxes.push(...update.failedAxes)
                }

                return { state }
            },
            classifyRetry: () => 'terminal',
            summarizeInput: input => `axes=${Object.keys(input).filter(key => key.startsWith('axis')).length} crops=${arrayLength(
                asRecord(input.crops)?.sourceCrops,
            )}`,
            summarizeOutput: output => {
                const state = asRecord(asRecord(output)?.state)

                return `extracted=${Object.keys(asRecord(state?.axisExtractions) ?? {}).length} failed=${arrayLength(state?.failedAxes)} crops=${arrayLength(
                    state?.sourceCrops,
                )}`
            },
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.synthesize',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.synthesize,
            validateInput: validateStateInput,
            validateOutput: validateStateOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) => {
                const state = readState(input.state)
                requireInstructions(input.instructions, 'synthesis instructions')

                return {
                    state: mergeCopy(state, await dependencies.runtime.synthesizeStyle({
                        state,
                        context,
                    })),
                }
            },
            classifyRetry: classifyProviderRetry,
            summarizeInput: input => `axes=${Object.keys(asRecord(asRecord(input.state)?.axisExtractions) ?? {}).length}`,
            summarizeOutput: output => `draft=${String(asRecord(asRecord(output)?.state)?.draft !== undefined)}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.generate-samples',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.generateSamples,
            validateInput: validateStateInput,
            validateOutput: validateStateOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) => {
                const state = readState(input.state)

                return {
                    state: mergeCopy(state, await dependencies.runtime.generateSamples({
                        state,
                        context,
                    })),
                }
            },
            classifyRetry: () => 'terminal',
            summarizeInput: input => `recommended=${arrayLength(asRecord(asRecord(input.state)?.draft)?.recommendedSampleSubjects)}`,
            summarizeOutput: output => `samples=${arrayLength(asRecord(asRecord(output)?.state)?.samples)}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'style.persist',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.persist,
            validateInput: validateStateInput,
            validateOutput: validatePersistOutput,
            authorize: authorizeStyleExtraction,
            execute: async (input, context) => {
                const state = readState(input.state)
                const finalState = mergeCopy(
                    state,
                    await dependencies.runtime.persistStyle({
                        state,
                        context,
                        allowedActionKeys: registry.allowedActionKeys(),
                    }),
                )

                return {
                    state: finalState,
                    capabilityId: finalState.capabilityId,
                    success: !finalState.error,
                    error: finalState.error,
                }
            },
            classifyRetry: error => isRetryablePersistenceError(error) ? 'retryable' : 'terminal',
            summarizeInput: input => `draft=${String(asRecord(asRecord(input.state)?.draft)?.name ?? 'none')}`,
            summarizeOutput: output => `capabilityId=${String(asRecord(output)?.capabilityId ?? '')}`,
        },
    )
    registerIfMissing(
        registry,
        {
            key: 'visual-style.apply',
            timeoutMs: styleExtractionSettings.actionTimeoutsMs.applyVisualStyle,
            validateInput: validateVisualStyleInput,
            validateOutput: validateVisualStyleOutput,
            authorize: context => context.rootCapabilityId.startsWith('visual-style.'),
            execute: (input, context) => {
                const root = context.plan.getManifest(context.rootCapabilityId)

                if (root?.manifest.tool?.toolType !== 'visual-style')
                    throw new CapabilityError('CAPABILITY_ACTION_NOT_ALLOWED', 'visual-style.apply requires a visual-style Tool manifest')

                const instructions = readResource(input.instructions, 'visual style instructions')
                const configuration = readResource(input.configuration, 'visual style configuration')
                const samples = Object
                    .entries(input)
                    .filter(([key]) => key.startsWith('sample'))
                    .sort(
                        ([left], [right]) => left.localeCompare(
                            right,
                            undefined,
                            { numeric: true },
                        ),
                    )
                    .map(([, value]) => readResource(value, 'visual style sample'))
                const manifestBlobHash = root.manifestBlobHash

                return {
                    mediaGenerationMode: 'visual-style',
                    preserveUserPrompt: false,
                    visualInstructions: [
                        new TextDecoder().decode(instructions.bytes),
                        'Structured visual configuration:',
                        new TextDecoder().decode(configuration.bytes),
                    ].join('\n\n'),
                    referenceImages: samples.map(sample => `data:${sample.ref.mediaType};base64,${Buffer.from(sample.bytes).toString('base64')}`),
                    referenceImageTraceUrls: samples.map(
                        sample =>
                            `/api/capabilities/${encodeURIComponent(context.rootCapabilityId)}/resources/${encodeURIComponent(sample.ref.resourceId)}?manifestBlobHash=${encodeURIComponent(manifestBlobHash)}`,
                    ),
                }
            },
            classifyRetry: () => 'terminal',
            summarizeInput: input => `samples=${Object.keys(input).filter(key => key.startsWith('sample')).length}`,
            summarizeOutput: output => `references=${arrayLength(asRecord(output)?.referenceImages)}`,
        },
    )
}

class ActionConcurrencyLimiter {
    private active = 0
    private readonly waiting: Array<() => void> = []

    constructor(private readonly limit: number) {
        if (
            !Number.isSafeInteger(limit)
            || limit < 1
        )
            throw new Error('Style extractor concurrency must be positive')
    }

    async run<T>(
        signal: AbortSignal,
        operation: () => Promise<T>,
    ): Promise<T> {
        await this.acquire(signal)

        try {
            return await operation()
        } finally {
            this.active -= 1
            this.waiting.shift()?.()
        }
    }

    private async acquire(signal: AbortSignal): Promise<void> {
        if (signal.aborted)
            throw signal.reason ?? new DOMException('Aborted', 'AbortError')

        if (this.active < this.limit) {
            this.active += 1

            return
        }

        await new Promise<void>((resolve, reject) => {
            const enter = (): void => {
                signal.removeEventListener('abort', abort)
                this.active += 1
                resolve()
            }
            const abort = (): void => {
                const index = this.waiting.indexOf(enter)

                if (index >= 0)
                    this.waiting.splice(index, 1)

                reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
            }
            this.waiting.push(enter)
            signal.addEventListener(
                'abort',
                abort,
                { once: true },
            )
        })
    }
}

const authorizeStyleExtraction = (context: { rootCapabilityId: string }): boolean => context.rootCapabilityId === STYLE_EXTRACTION_CAPABILITY_IDS.tool

const mergeCopy = (
    state: StyleExtractionRuntimeState,
    update: Partial<StyleExtractionRuntimeState>,
): StyleExtractionRuntimeState => {
    const copy = structuredClone(state)
    mergeState(copy, update)

    return copy
}

const mergeState = (
    state: StyleExtractionRuntimeState,
    update: Readonly<Record<string, unknown>>,
): void => {
    for (const [key, value] of Object.entries(update)) {
        if (value !== undefined)
            state[key] = value
    }
}

const readState = (value: unknown): StyleExtractionRuntimeState => {
    const state = asRecord(value)

    if (
        !state
        || !asRecord(state.input)
        || !Array.isArray(state.references)
        || !asRecord(state.axisExtractions)
        || !Array.isArray(state.failedAxes)
        || !Array.isArray(state.sourceCrops)
        || !Array.isArray(state.samples)
    )
        throw new CapabilityError('CAPABILITY_ACTION_INPUT_INVALID', 'Style Extraction state is invalid')

    return value as StyleExtractionRuntimeState
}

const requireInstructions = (
    value: unknown,
    label: string,
): void => {
    const resource = asRecord(value)

    if (
        !(resource?.bytes instanceof Uint8Array)
        || resource.bytes.byteLength === 0
    )
        throw new CapabilityError('CAPABILITY_RESOURCE_INVALID', `${label} are missing`)
}

const readResource = (
    value: unknown,
    label: string,
): {
    bytes: Uint8Array
    ref: {
        resourceId: string
        mediaType: string
    }
} => {
    const resource = asRecord(value)
    const ref = asRecord(resource?.ref)

    if (
        !(resource?.bytes instanceof Uint8Array)
        || typeof ref?.resourceId !== 'string'
        || typeof ref.mediaType !== 'string'
    )
        throw new CapabilityError('CAPABILITY_RESOURCE_INVALID', `${label} are missing`)

    return {
        bytes: resource.bytes,
        ref: ref as {
            resourceId: string
            mediaType: string
        },
    }
}

const readString = (
    value: unknown,
    label: string,
): string => {
    if (
        typeof value !== 'string'
        || !value
    )
        throw new CapabilityError('CAPABILITY_ACTION_INPUT_INVALID', `${label} is required`)

    return value
}

const validateObject = (value: unknown): CapabilityActionValidationResult => {
    return asRecord(value) ? { valid: true } : {
        valid: false,
        message: 'Value must be an object',
    }
}

const validateStateInput = (value: Readonly<Record<string, unknown>>): CapabilityActionValidationResult => {
    return asRecord(value.state) ? { valid: true } : {
        valid: false,
        message: 'state must be an object',
    }
}

const validateStateOutput = (value: unknown): CapabilityActionValidationResult => {
    return asRecord(asRecord(value)?.state) ? { valid: true } : {
        valid: false,
        message: 'output.state must be an object',
    }
}

const validateAxisInput = (value: Readonly<Record<string, unknown>>): CapabilityActionValidationResult => {
    return asRecord(value.state)
        && typeof value.axis === 'string'
        ? { valid: true }
        : {
            valid: false,
            message: 'state and axis are required',
        }
}

const validateAxisOutput = (value: unknown): CapabilityActionValidationResult => {
    const output = asRecord(value)

    return output
        && asRecord(output.axisExtractions)
        && Array.isArray(output.failedAxes)
        ? { valid: true }
        : {
            valid: false,
            message: 'axis extraction output is invalid',
        }
}

const validateCropsOutput = (value: unknown): CapabilityActionValidationResult => {
    return Array.isArray(asRecord(value)?.sourceCrops)
        ? { valid: true }
        : {
            valid: false,
            message: 'sourceCrops must be an array',
        }
}

const validateVisualStyleInput = (value: Readonly<Record<string, unknown>>): CapabilityActionValidationResult => {
    return asRecord(value.instructions)
        && asRecord(value.configuration)
        ? { valid: true }
        : {
            valid: false,
            message: 'visual style instructions and configuration are required',
        }
}

const validateVisualStyleOutput = (value: unknown): CapabilityActionValidationResult => {
    const output = asRecord(value)

    return output?.mediaGenerationMode === 'visual-style'
        && output.preserveUserPrompt === false
        && typeof output.visualInstructions === 'string'
        && Array.isArray(output.referenceImages)
        && Array.isArray(output.referenceImageTraceUrls)
        ? { valid: true }
        : {
            valid: false,
            message: 'visual style output is invalid',
        }
}

const validateMergeInput = (value: Readonly<Record<string, unknown>>): CapabilityActionValidationResult => {
    return asRecord(value.state)
        && asRecord(value.crops)
        ? { valid: true }
        : {
            valid: false,
            message: 'state and crops are required',
        }
}

const validatePersistOutput = (value: unknown): CapabilityActionValidationResult => {
    const output = asRecord(value)

    return output
        && asRecord(output.state)
        && typeof output.success === 'boolean'
        ? { valid: true }
        : {
            valid: false,
            message: 'persist output is invalid',
        }
}

const registerIfMissing = (
    registry: CapabilityActionRegistry,
    definition: Parameters<CapabilityActionRegistry['register']>[0],
): void => {
    if (!registry.has(definition.key))
        registry.register(definition)
}

const classifyProviderRetry = (error: unknown): 'retryable' | 'terminal' => {
    const message = error instanceof Error ? error.message : String(error)

    return /timeout|rate.?limit|connection|temporar|unavailable|429|502|503|504/i.test(message)
        ? 'retryable'
        : 'terminal'
}

const isRetryablePersistenceError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)

    return /throttl|timeout|conflict|temporar|unavailable/i.test(message)
}

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
    return value
        && typeof value === 'object'
        && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}
