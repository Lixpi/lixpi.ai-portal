import * as process from 'process'

import { GoogleGenAI } from '@google/genai'
import {
    info,
    warn,
    err,
} from '@lixpi/debug-tools'

import {
    BaseProvider,
    type BaseProviderDeps,
} from './base-provider.ts'
import {
    type ProviderName,
} from '@lixpi/constants'
import {
    type ProviderState,
    type ChatMessage,
} from '../graph/state.ts'
import { getSystemPrompt } from '../prompts/load-prompts.ts'
import {
    assertMessageInputKindsSupported,
    convertAttachmentsForProvider,
    parseDataUrl,
    resolveImageUrls,
} from '../utils/attachments.ts'
import {
    TOOL_NAME,
    applyImagePromptLimitToSystemPrompt,
    extractReferenceImages,
    getToolForProvider,
} from '../tools/image-generation.ts'
import {
    VIDEO_TOOL_NAME,
    getVideoToolForProvider,
    type VideoToolCall,
} from '../tools/video-generation.ts'
import { VEO_POLL_INTERVAL_MS } from '../config.ts'
import {
    buildGoogleRequiredCapabilityToolConfig,
    CapabilityModelToolExecutor,
    shouldExposeCapabilityModelTools,
} from '../../capability-system/capability-model-tool-executor.ts'
import { asGoogleTool } from '@lixpi/capability-system/backend'
import {
    type ResolvedImageGenerationReference,
} from '../image-generation-references.ts'
import { assessProviderInputBudget } from './provider-input-budget.ts'
import { buildImageReferencePromptLabel } from './image-reference-adapters.ts'
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Carries the provider's operation error code to callers alongside the readable reason.
class VeoOperationError extends Error {
    readonly code?: string

    constructor(
        message: string,
        code: string | undefined,
    ) {
        super(message)
        this.code = code
    }
}

type VeoImageInput = {
    imageBytes: string
    mimeType: string
}

type GoogleToolStreamResult = {
    detectedImage?: string
    detectedVideo?: VideoToolCall
    capabilityCalls: Array<{
        callId: string
        name: string
        arguments: Record<string, any>
        part: any
    }>
    usageMetadata?: any
    textCharacterCount: number
    finishReasons: string[]
    functionCallNames: string[]
}

type VeoOperationSummary = {
    operationName: string | null
    done: boolean
    pollCount: number
    elapsedMs: number
    operationKeys: string[]
    metadataKeys: string[]
    responseKeys: string[]
    error: {
        code: string | number | null
        message: string | null
        keys: string[]
    } | null
    generatedVideoCount: number
    generatedVideos: Array<{
        index: number
        keys: string[]
        hasVideo: boolean
        videoKeys: string[]
        hasInlineBytes: boolean
        hasUri: boolean
        mimeType: string | null
    }>
    raiMediaFilteredCount: number | null
    raiMediaFilteredReasons: string[]
}

const getObjectKeys = (value: unknown): string[] => (
    value
        && typeof value === 'object'
        ? Object.keys(value)
        : []
)

const getVeoOperationSummary = (
    operation: any,
    pollCount: number,
    startedAt: number,
): VeoOperationSummary => {
    const response = operation?.response
    const generatedVideos = Array.isArray(response?.generatedVideos) ? response.generatedVideos : []
    const operationError = operation?.error

    return {
        operationName: typeof operation?.name === 'string' ? operation.name : null,
        done: operation?.done === true,
        pollCount,
        elapsedMs: Date.now() - startedAt,
        operationKeys: getObjectKeys(operation),
        metadataKeys: getObjectKeys(operation?.metadata),
        responseKeys: getObjectKeys(response),
        error: operationError
            ? {
                code: typeof operationError?.code === 'string'
                    || typeof operationError?.code === 'number'
                    ? operationError.code
                    : null,
                message: typeof operationError?.message === 'string' ? operationError.message : null,
                keys: getObjectKeys(operationError),
            }
            : null,
        generatedVideoCount: generatedVideos.length,
        generatedVideos: generatedVideos.map((generatedVideo: any, index: number) => {
            const video = generatedVideo?.video

            return {
                index,
                keys: getObjectKeys(generatedVideo),
                hasVideo: !!video,
                videoKeys: getObjectKeys(video),
                hasInlineBytes: typeof video?.videoBytes === 'string' && video.videoBytes.length > 0,
                hasUri: typeof video?.uri === 'string' && video.uri.length > 0,
                mimeType: typeof video?.mimeType === 'string' ? video.mimeType : null,
            }
        }),
        raiMediaFilteredCount: typeof response?.raiMediaFilteredCount === 'number'
            ? response.raiMediaFilteredCount
            : null,
        raiMediaFilteredReasons: Array.isArray(response?.raiMediaFilteredReasons)
            ? response.raiMediaFilteredReasons.filter((reason: unknown): reason is string => typeof reason === 'string')
            : [],
    }
}

const buildVeoNoVideoError = (summary: VeoOperationSummary): string => {
    const diagnostics = [
        `operation=${summary.operationName ?? '<missing>'}`,
        `generatedVideoCount=${summary.generatedVideoCount}`,
        `raiMediaFilteredCount=${summary.raiMediaFilteredCount ?? 0}`,
    ]

    if (summary.raiMediaFilteredReasons.length > 0)
        diagnostics.push(`raiMediaFilteredReasons=${JSON.stringify(summary.raiMediaFilteredReasons)}`)

    if (summary.responseKeys.length > 0)
        diagnostics.push(`responseKeys=${JSON.stringify(summary.responseKeys)}`)

    return `VEO: operation completed without a video (${diagnostics.join(', ')})`
}

const getGooglePartSummary = (part: any): Record<string, unknown> => {
    const text = typeof part?.text === 'string' ? part.text : ''

    return {
        hasText: text.length > 0,
        textPreview: text ? text.slice(0, 240) : '',
        hasInlineData: Boolean(part?.inlineData?.data || part?.inline_data?.data),
        hasFunctionCall: Boolean(part?.functionCall || part?.function_call),
    }
}

export const getGoogleImageResponseSummary = (response: any): Record<string, unknown> => ({
    promptFeedback: response?.promptFeedback ?? response?.prompt_feedback,
    candidates: (response?.candidates ?? []).map(
        (candidate: any, index: number) => ({
            index,
            finishReason: candidate?.finishReason ?? candidate?.finish_reason,
            safetyRatings: candidate?.safetyRatings ?? candidate?.safety_ratings,
            partTypes: (candidate?.content?.parts ?? []).map(getGooglePartSummary),
        }),
    ),
})

export const buildVeoReferenceImages = (refs: VeoImageInput[]): Array<{
    image: VeoImageInput
    referenceType: 'asset'
}> => {
    return refs.map(
        image => ({
            image,
            referenceType: 'asset',
        }),
    )
}

const buildGoogleImageReferenceLabel = (
    reference: ResolvedImageGenerationReference,
    index: number,
): string => buildImageReferencePromptLabel(
    reference,
    index,
    'REFERENCE IMAGE',
)

export class GoogleProvider extends BaseProvider {
    readonly providerName: ProviderName = 'Google'
    private readonly client: GoogleGenAI

    constructor(
        instanceKey: string,
        deps: BaseProviderDeps,
    ) {
        super(instanceKey, deps)
        const apiKey = process.env.GOOGLE_API_KEY

        if (!apiKey)
            throw new Error('GOOGLE_API_KEY environment variable is required')

        this.client = new GoogleGenAI({ apiKey })
    }

    // No transportFaultNames override: @google/genai calls fetch directly and
    // does not wrap socket failures in an SDK class — they arrive as
    // `TypeError: fetch failed` carrying the real code on `cause`, which the
    // shared socket layer covers. Its own ApiError is an HTTP-status error and
    // is deliberately not retried.

    protected override async streamImpl(state: ProviderState): Promise<Partial<ProviderState>> {
        assertMessageInputKindsSupported(
            'Google',
            state.modelVersion,
            state.aiModelMetaInfo.inferenceCapabilities,
            state.messages,
        )
        const messages = state.messages
        const modelVersion = state.modelVersion
        const maxTokens = state.maxCompletionSize
        const temperature = state.temperature ?? 0.7
        const capabilities = state.aiModelMetaInfo.inferenceCapabilities
        const supportsSystemPrompt = capabilities.supportsSystemPrompt
        const enableImageGeneration = state.enableImageGeneration ?? false
        const imageSize = state.imageSize ?? 'auto'

        const modalities = (state.aiModelMetaInfo as any)?.modalities ?? []
        const modelSupportsImageOutput = Array.isArray(modalities) && modalities.some((m: any) => {
            const modality = typeof m === 'object' ? m?.modality : m

            return modality === 'image' || modality === 'image_generation'
        })
        const effectiveImageGen = enableImageGeneration && modelSupportsImageOutput

        const hasImageModel = !!state.imageModelVersion
        const injectTool = hasImageModel && !enableImageGeneration

        const enableVideoGeneration = state.enableVideoGeneration ?? false
        const modelSupportsVideoOutput = Array.isArray(modalities) && modalities.some((m: any) => {
            const modality = typeof m === 'object' ? m?.modality : m

            return modality === 'video' || modality === 'video_generation'
        })
        const effectiveVideoGen = enableVideoGeneration && modelSupportsVideoOutput

        const hasVideoModel = !!state.videoModelVersion
        const injectVideoTool = hasVideoModel
            && !enableImageGeneration
            && !enableVideoGeneration
        let mediaFanoutAllowedFunctionNames: string[] = []
        const providerFunctionDeclarations: Array<Record<string, any>> = []
        const capabilityToolExecutor = shouldExposeCapabilityModelTools(state)
            ? new CapabilityModelToolExecutor(
                state,
                this.capabilityDispatcher,
                {
                    onGenerationTrace: trace => this.publisher.capabilityGenerationTrace(trace),
                },
            )
            : undefined

        // Resolve message content (so reference-image extraction sees data URLs)
        // and convert each message to a Google `Content` object.
        const resolvedMessages: ChatMessage[] = []
        const contents: Array<Record<string, any>> = []

        for (const msg of messages) {
            let content: any = msg.content ?? ''
            content = await resolveImageUrls(content, this.nats)
            resolvedMessages.push({
                role: msg.role,
                content,
            })

            content = convertAttachmentsForProvider(content, 'GOOGLE')
            const role = msg.role === 'assistant' ? 'model' : msg.role
            contents.push({
                role,
                parts: this.buildParts(content),
            })
        }

        const resolvedImageGenerationReferences = state.resolvedImageGenerationReferences ?? []

        if (
            effectiveImageGen
            && resolvedImageGenerationReferences.length > 0
        ) {
            let targetUserContent: Record<string, any> | undefined

            for (let index = contents.length - 1; index >= 0; index--) {
                if (contents[index]?.role === 'user') {
                    targetUserContent = contents[index]

                    break
                }
            }

            if (!targetUserContent)
                throw new Error('No user prompt found for image generation')

            const parts = Array.isArray(targetUserContent.parts) ? targetUserContent.parts : []
            targetUserContent.parts = [
                ...parts,
                ...resolvedImageGenerationReferences.flatMap(
                    (reference, index) => [
                        { text: buildGoogleImageReferenceLabel(reference, index) },
                        {
                            inlineData: {
                                mimeType: reference.mediaType,
                                data: reference.bytes.toString('base64'),
                            },
                        },
                    ],
                ),
            ]
        }

        const config: Record<string, any> = {}

        if (capabilities.supportsTemperature)
            config.temperature = temperature

        if (maxTokens)
            config.maxOutputTokens = maxTokens

        if (effectiveImageGen) {
            config.responseModalities = ['TEXT', 'IMAGE']
            const requestedResolution = state.imageGenerationConfig?.resolution

            if (
                (imageSize && imageSize !== 'auto')
                || requestedResolution
            ) {
                config.imageConfig = {
                    ...(imageSize
                        && imageSize !== 'auto'
                        ? { aspectRatio: imageSize }
                        : {}),
                    ...(requestedResolution ? { imageSize: requestedResolution } : {}),
                }
            }
        }

        const thinkingLevel = state.reasoningGenerationConfig?.thinkingLevel

        if (thinkingLevel)
            config.thinkingConfig = { thinkingLevel }

        if (
            injectTool
            || injectVideoTool
            || capabilityToolExecutor
        ) {
            if (injectTool) {
                const toolDef = getToolForProvider(
                    'Google',
                    state.imageModelMetaInfo,
                    state.imageProviderName,
                )
                providerFunctionDeclarations.push({
                    name: TOOL_NAME,
                    description: toolDef.description,
                    parameters: toolDef.parameters,
                })
                mediaFanoutAllowedFunctionNames.push(TOOL_NAME)
            }

            if (injectVideoTool) {
                const videoToolDef = getVideoToolForProvider('Google')
                providerFunctionDeclarations.push({
                    name: VIDEO_TOOL_NAME,
                    description: videoToolDef.description,
                    parameters: videoToolDef.parameters,
                })
                mediaFanoutAllowedFunctionNames.push(VIDEO_TOOL_NAME)
            }

            const initialFunctionDeclarations = [
                ...providerFunctionDeclarations,
                ...(capabilityToolExecutor?.definitions().map(asGoogleTool) ?? []),
            ]

            if (initialFunctionDeclarations.length > 0)
                config.tools = [{ functionDeclarations: initialFunctionDeclarations }]

            if (
                state.capabilityUsageMode === 'character-creator'
                && mediaFanoutAllowedFunctionNames.includes(TOOL_NAME)
            ) {
                config.toolConfig = {
                    functionCallingConfig: {
                        mode: 'ANY',
                        allowedFunctionNames: [TOOL_NAME],
                    },
                }
            }
        }

        let systemInstruction: string | undefined

        if (supportsSystemPrompt) {
            systemInstruction = getSystemPrompt(injectTool, injectVideoTool)

            if (
                injectTool
                && systemInstruction
            ) {
                systemInstruction = applyImagePromptLimitToSystemPrompt(
                    systemInstruction,
                    state.imageModelMetaInfo,
                    state.imageProviderName,
                ) ?? systemInstruction
            }
        }

        if (systemInstruction)
            config.systemInstruction = systemInstruction

        if (
            effectiveImageGen
            && capabilities.thinkingMode === 'google-level'
        ) {
            config.thinkingConfig = {
                ...config.thinkingConfig,
                includeThoughts: true,
            }
        }

        const update: Partial<ProviderState> = {}

        try {
            if (
                !effectiveImageGen
                && !effectiveVideoGen
            )
                this.publisher.start()

            let usageMetadata: any = null

            if (effectiveVideoGen) {
                // Native video-generation path (called via VideoRouter). Async
                // submit + poll with keepalive pings; no streamed partial frames.
                await this.runVeoGeneration(state)
                update.generatedVideos = ['veo-complete']
                update.videoUsage = {
                    durationSeconds: state.videoDurationSeconds ?? 0,
                    resolution: state.videoResolution ?? '',
                    aspectRatio: state.videoAspectRatio ?? '',
                }
            } else if (effectiveImageGen) {
                // Native image-generation path (called via ImageRouter).
                const inputImageCount = contents.reduce(
                    (acc, c) =>
                        acc + (Array.isArray((c as any).parts)
                            ? (c as any).parts.filter((p: any) => p?.inlineData || p?.inline_data).length
                            : 0),
                    0,
                )
                const inputTextLen = contents.reduce(
                    (acc, c) =>
                        acc + (Array.isArray((c as any).parts)
                            ? (c as any).parts.reduce((s: number, p: any) => s + (typeof p?.text === 'string' ? p.text.length : 0), 0)
                            : 0),
                    0,
                )
                info(
                    `[Google:${this.instanceKey}] image-gen call ${
                        JSON.stringify(
                            {
                                model: modelVersion,
                                responseModalities: config.responseModalities,
                                aspectRatio: (config as any).imageConfig?.aspectRatio ?? 'auto',
                                imageSize: (config as any).imageConfig?.imageSize ?? 'provider-default',
                                temperature,
                                maxOutputTokens: maxTokens,
                                contentsCount: contents.length,
                                inputImageCount,
                                inputTextLen,
                                referenceMetadata: resolvedImageGenerationReferences.map(
                                    reference => ({
                                        role: reference.role,
                                        fileName: reference.fileName,
                                        byteLength: reference.byteLength,
                                        mediaType: reference.mediaType,
                                        sha256: reference.sha256,
                                    }),
                                ),
                            },
                            null,
                            0,
                        )
                    }`,
                )
                await this.imagePub.partial('', 0)
                assessProviderInputBudget({
                    state,
                    request: {
                        model: modelVersion,
                        contents,
                        config,
                    },
                })
                // Non-streaming image call: nothing is published until it
                // returns, so the whole request is safe to reattempt.
                const response = await this.retryTransport(
                    'image',
                    async () =>
                        await this.client.models.generateContent({
                            model: modelVersion,
                            contents: contents as any,
                            config: config as any,
                        }),
                )
                usageMetadata = response.usageMetadata

                // Collect image parts in order. Gemini 3 image models may emit
                // images marked thought=true; treat all parts equally and use
                // the LAST image part as the final.
                const imageParts: string[] = []
                const textChunks: string[] = []

                for (const candidate of response.candidates ?? []) {
                    if (!candidate.content?.parts)
                        continue

                    for (const part of candidate.content.parts) {
                        if (this.shouldStop)
                            break

                        const inline = (part as any).inlineData ?? (part as any).inline_data
                        const text = (part as any).text

                        if (inline?.data) {
                            imageParts.push(inline.data) // already base64 in JS SDK
                        } else if (text)
                            textChunks.push(text)
                    }
                }

                if (textChunks.length > 0)
                    this.publisher.chunk(
                        textChunks.join(''),
                    )

                if (imageParts.length === 0) {
                    const errMsg = `Google image model ${modelVersion} returned no inline image data.`
                    err(`[Google:${this.instanceKey}] ${errMsg} ${JSON.stringify(
                        getGoogleImageResponseSummary(response),
                        null,
                        0,
                    )}`)
                    update.error = errMsg
                } else {
                    for (let i = 0; i < imageParts.length - 1; i++) {
                        await this.imagePub.partial(imageParts[i]!, i + 1)
                    }

                    const final = imageParts.at(-1)!
                    await this.imagePub.complete({
                        imageBase64: final,
                        responseId: '',
                        revisedPrompt: '',
                        imageModelId: modelVersion,
                    })
                    update.generatedImages = [final]
                }
            } else if (
                injectTool
                || injectVideoTool
                || capabilityToolExecutor
            ) {
                const runToolStream = async (
                    streamConfig: Record<string, any>,
                    publishText: boolean,
                ): Promise<GoogleToolStreamResult> => {
                    const pendingRequiredToolName = capabilityToolExecutor?.pendingRequiredToolName()
                    const functionDeclarations = [
                        ...providerFunctionDeclarations,
                        ...(capabilityToolExecutor?.definitions().map(asGoogleTool) ?? []),
                    ]
                    const streamConfigWithoutTools = { ...streamConfig }
                    delete streamConfigWithoutTools.tools
                    const currentStreamConfig = functionDeclarations.length > 0
                        ? {
                            ...streamConfigWithoutTools,
                            tools: [{ functionDeclarations }],
                        }
                        : streamConfigWithoutTools
                    const completionSystemInstruction = capabilityToolExecutor?.withCompletionInstruction(currentStreamConfig.systemInstruction)
                    const currentStreamConfigWithInstruction = completionSystemInstruction
                        ? {
                            ...currentStreamConfig,
                            systemInstruction: completionSystemInstruction,
                        }
                        : currentStreamConfig
                    const effectiveStreamConfig = pendingRequiredToolName
                        ? {
                            ...currentStreamConfigWithInstruction,
                            toolConfig: buildGoogleRequiredCapabilityToolConfig(pendingRequiredToolName),
                        }
                        : currentStreamConfigWithInstruction
                    assessProviderInputBudget({
                        state,
                        request: {
                            model: modelVersion,
                            contents,
                            config: effectiveStreamConfig,
                        },
                    })
                    // Submit only — the drain below publishes as it goes.
                    const stream = await this.retryTransport(
                        'stream',
                        async () =>
                            await this.client.models.generateContentStream({
                                model: modelVersion,
                                contents: contents as any,
                                config: effectiveStreamConfig as any,
                            }),
                    )
                    let detectedImage: string | undefined
                    let detectedVideo: VideoToolCall | undefined
                    const capabilityCalls: Array<{
                        callId: string
                        name: string
                        arguments: Record<string, any>
                        part: any
                    }> = []
                    let streamUsageMetadata: any = null
                    let textCharacterCount = 0
                    const finishReasons = new Set<string>()
                    const functionCallNames = new Set<string>()

                    for await (const chunk of stream) {
                        if (this.shouldStop)
                            break

                        if (chunk.usageMetadata)
                            streamUsageMetadata = chunk.usageMetadata

                        for (const candidate of chunk.candidates ?? []) {
                            if (typeof candidate.finishReason === 'string')
                                finishReasons.add(candidate.finishReason)

                            if (!candidate.content?.parts)
                                continue

                            for (const part of candidate.content.parts) {
                                const fnCall = (part as any).functionCall ?? (part as any).function_call

                                if (typeof fnCall?.name === 'string')
                                    functionCallNames.add(fnCall.name)

                                if (
                                    fnCall
                                    && fnCall.name === TOOL_NAME
                                )
                                    detectedImage = (fnCall.args ?? {}).prompt ?? ''
                                else if (
                                    fnCall
                                    && fnCall.name === VIDEO_TOOL_NAME
                                ) {
                                    const args = fnCall.args ?? {}
                                    detectedVideo = {
                                        prompt: args.prompt ?? '',
                                        ...(typeof args.negativePrompt === 'string'
                                            && args.negativePrompt.length > 0
                                            ? { negativePrompt: args.negativePrompt }
                                            : {}),
                                    }
                                } else if (
                                    fnCall
                                    && capabilityToolExecutor?.recognizes(fnCall.name)
                                ) {
                                    capabilityCalls.push({
                                        callId: fnCall.id ?? `${fnCall.name}-${capabilityCalls.length}`,
                                        name: fnCall.name,
                                        arguments: fnCall.args ?? {},
                                        part,
                                    })
                                } else if (typeof (part as any).text === 'string') {
                                    textCharacterCount += (part as any).text.length

                                    if (publishText)
                                        this.publisher.chunk((part as any).text)
                                }
                            }
                        }
                    }

                    return {
                        detectedImage,
                        detectedVideo,
                        capabilityCalls,
                        usageMetadata: streamUsageMetadata,
                        textCharacterCount,
                        finishReasons: [...finishReasons],
                        functionCallNames: [...functionCallNames],
                    }
                }

                let toolStreamResult = await runToolStream(config, true)
                usageMetadata = mergeGoogleUsageMetadata(usageMetadata, toolStreamResult.usageMetadata)

                for (let round = 0; toolStreamResult.capabilityCalls.length > 0; round++) {
                    if (round >= 4)
                        throw new Error('Capability model-tool round limit exceeded')

                    const executions = []

                    for (const call of toolStreamResult.capabilityCalls) {
                        executions.push(await capabilityToolExecutor!.execute(call, this.signal))
                    }

                    contents.push({
                        role: 'model',
                        parts: toolStreamResult.capabilityCalls.map(call => call.part),
                    })
                    contents.push({
                        role: 'user',
                        parts: executions.map(
                            execution => ({
                                functionResponse: {
                                    name: execution.call.name,
                                    response: execution.result,
                                },
                            }),
                        ),
                    })
                    toolStreamResult = await runToolStream(config, true)
                    usageMetadata = mergeGoogleUsageMetadata(usageMetadata, toolStreamResult.usageMetadata)
                }

                let detectedImage = toolStreamResult.detectedImage
                let detectedVideo = toolStreamResult.detectedVideo

                if (state.capabilityUsageMode === 'character-creator') {
                    detectedVideo = undefined
                    mediaFanoutAllowedFunctionNames = mediaFanoutAllowedFunctionNames.filter(name => name === TOOL_NAME)
                }

                const explicitVideoToolRequired = injectVideoTool
                    && state.capabilityUsageMode !== 'character-creator'
                    && !injectTool
                // AUTO tool selection is unreliable on the smaller Gemini models — they
                // answer a media request with plain text instead of calling the tool. Any
                // media request (fanout or single-media) retries with a forced call.
                const forcedFunctionNames = explicitVideoToolRequired
                    ? [VIDEO_TOOL_NAME]
                    : mediaFanoutAllowedFunctionNames
                const shouldForceMediaTool = explicitVideoToolRequired
                    ? !detectedVideo
                    : !detectedImage && !detectedVideo

                if (
                    shouldForceMediaTool
                    && state.capabilityUsageMode !== 'character-creator'
                    && !this.shouldStop
                    && forcedFunctionNames.length > 0
                ) {
                    warn(
                        `[Google:${this.instanceKey}] AUTO tool selection did not satisfy the media request; retrying with forced function call ${
                            JSON.stringify(
                                {
                                    explicitVideoToolRequired,
                                    forcedFunctionNames,
                                    detectedImage: !!detectedImage,
                                    detectedVideo: !!detectedVideo,
                                    textCharacterCount: toolStreamResult.textCharacterCount,
                                    finishReasons: toolStreamResult.finishReasons,
                                    functionCallNames: toolStreamResult.functionCallNames,
                                },
                                null,
                                0,
                            )
                        }`,
                    )
                    toolStreamResult = await runToolStream(
                        {
                            ...config,
                            toolConfig: {
                                functionCallingConfig: {
                                    mode: 'ANY',
                                    allowedFunctionNames: forcedFunctionNames,
                                },
                            },
                        },
                        false,
                    )
                    usageMetadata = mergeGoogleUsageMetadata(usageMetadata, toolStreamResult.usageMetadata)
                    detectedImage = toolStreamResult.detectedImage
                    detectedVideo = toolStreamResult.detectedVideo
                }

                if (
                    explicitVideoToolRequired
                    && !this.shouldStop
                    && !detectedVideo
                ) {
                    throw new Error(
                        `Google reasoning model failed to emit required generate_video tool call ${
                            JSON.stringify(
                                {
                                    model: modelVersion,
                                    detectedImage: !!detectedImage,
                                    textCharacterCount: toolStreamResult.textCharacterCount,
                                    finishReasons: toolStreamResult.finishReasons,
                                    functionCallNames: toolStreamResult.functionCallNames,
                                },
                                null,
                                0,
                            )
                        }`,
                    )
                }

                if (detectedVideo) {
                    update.generatedVideoPrompt = detectedVideo.prompt
                    update.generatedVideoNegativePrompt = detectedVideo.negativePrompt
                    info(
                        `[Google:${this.instanceKey}] generate_video tool call ${
                            JSON.stringify(
                                {
                                    chatModel: modelVersion,
                                    targetVideoProvider: state.videoProviderName,
                                    targetVideoModel: state.videoModelVersion,
                                    promptLen: detectedVideo.prompt.length,
                                    negativePromptLen: detectedVideo.negativePrompt?.length ?? 0,
                                },
                                null,
                                0,
                            )
                        }`,
                    )
                } else if (detectedImage) {
                    const refs = extractReferenceImages(resolvedMessages)
                    update.generatedImagePrompt = detectedImage
                    update.referenceImages = refs
                    info(
                        `[Google:${this.instanceKey}] generate_image tool call ${
                            JSON.stringify(
                                {
                                    chatModel: modelVersion,
                                    targetImageProvider: state.imageProviderName,
                                    targetImageModel: state.imageModelVersion,
                                    promptLen: detectedImage.length,
                                    referenceImagesExtracted: refs.length,
                                },
                                null,
                                0,
                            )
                        }`,
                    )
                } else if (
                    injectTool
                    && state.capabilityMediaExecutionPlan
                )
                    info(
                        `[Google:${this.instanceKey}] using required Capability media plan without a generate_image tool call (model=${modelVersion})`,
                    )
                else if (
                    injectTool
                    && injectVideoTool
                )
                    warn(`Google did not emit generate_image or generate_video tool call for ${this.instanceKey}`)
                else if (injectTool)
                    warn(`Google did not emit generate_image tool call for ${this.instanceKey}`)
                else
                    warn(`Google did not emit generate_video tool call for ${this.instanceKey}`)
            } else {
                // Pure text streaming
                assessProviderInputBudget({
                    state,
                    request: {
                        model: modelVersion,
                        contents,
                        config,
                    },
                })
                // Submit only — the drain below publishes as it goes.
                const stream = await this.retryTransport(
                    'text',
                    async () =>
                        await this.client.models.generateContentStream({
                            model: modelVersion,
                            contents: contents as any,
                            config: config as any,
                        }),
                )

                for await (const chunk of stream) {
                    if (this.shouldStop)
                        break

                    if (chunk.usageMetadata)
                        usageMetadata = chunk.usageMetadata

                    for (const candidate of chunk.candidates ?? []) {
                        if (!candidate.content?.parts)
                            continue

                        for (const part of candidate.content.parts) {
                            if ((part as any).text)
                                this.publisher.chunk((part as any).text)
                        }
                    }
                }
            }

            if (usageMetadata) {
                const promptTokens = usageMetadata.promptTokenCount ?? 0
                const reasoningTokens = usageMetadata.thoughtsTokenCount ?? 0
                // Gemini reports thinking (thoughts) separately from candidates but
                // bills it as output. Fold reasoning into completionTokens so the
                // contract invariant holds (completionTokens INCLUDES reasoning, like
                // OpenAI's output_tokens) and the metering backend charges it; keep the subset in
                // completionReasoningTokens for reference.
                const completionTokens = (usageMetadata.candidatesTokenCount ?? 0) + reasoningTokens
                update.usage = {
                    promptTokens,
                    promptAudioTokens: 0,
                    promptCachedTokens: usageMetadata.cachedContentTokenCount ?? 0,
                    completionTokens,
                    completionAudioTokens: 0,
                    completionReasoningTokens: reasoningTokens,
                    totalTokens: usageMetadata.totalTokenCount ?? (promptTokens + completionTokens),
                }
                update.aiVendorRequestId = `google-${state.workspaceId}-${state.aiChatThreadId}`
            }

            if (
                effectiveImageGen
                && !update.error
            ) {
                update.imageUsage = {
                    generatedCount: 1,
                    size: imageSize,
                    quality: 'high',
                }
            }

            if (
                !effectiveImageGen
                && !effectiveVideoGen
                && !state.pendingCapabilityOutputFinalizations?.length
            )
                this.publisher.end()
        } catch (e: any) {
            err(`Google streaming failed: ${e?.message ?? e}`)
            update.error = e?.message ?? String(e)

            if (
                !effectiveImageGen
                && !effectiveVideoGen
            ) {
                this.publisher.error(update.error)
                this.publisher.end()
            }
        }

        return update
    }

    private buildParts(content: any): Array<Record<string, any>> {
        if (typeof content === 'string')
            return [{ text: content }]

        if (!Array.isArray(content))
            return [{ text: String(content) }]

        const parts: Array<Record<string, any>> = []

        for (const block of content) {
            if (
                typeof block !== 'object'
                || block === null
            )
                continue

            if ('text' in block)
                parts.push({ text: block.text })
            else if ('inlineData' in block)
                parts.push({ inlineData: block.inlineData })
            else if ('inline_data' in block) {
                const inline = block.inline_data
                parts.push({ inlineData: {
                    data: inline.data,
                    mimeType: inline.mime_type,
                } })
            }
        }

        return parts.length > 0 ? parts : [{ text: '' }]
    }

    // Synchronous submit + poll loop for VEO video generation. Emits
    // VIDEO_PENDING immediately, then VIDEO_GENERATING keepalive pings every
    // VEO_POLL_INTERVAL_MS, then VIDEO_COMPLETE on success (or VIDEO_ERROR +
    // throws on failure, which the streamImpl catch converts to update.error).
    //
    // Provided reference images are used as FRAME CONDITIONING ONLY (never asset
    // or style references): the first selected image is the start frame (VEO's
    // top-level `image`) and the second, when present, is the stop frame (config
    // `lastFrame`, first/last-frame interpolation). They arrive in a stable order
    // via state.videoFirstFrameImage (start) followed by state.videoReferenceImages
    // (the optional stop frame), populated by the structured VLM resolver.
    private async runVeoGeneration(state: ProviderState): Promise<void> {
        const modelVersion = state.modelVersion
        // VideoRouter passes the prompt as the first user message's string content.
        const first = state.messages[0]
        const prompt = typeof first?.content === 'string' ? first.content : ''

        if (!prompt)
            throw new Error('VEO: missing prompt in user message')

        let veoConfig: Record<string, any> = {
            numberOfVideos: 1,
            abortSignal: this.signal,
        }
        const generationConfig = state.videoGenerationConfig ?? {}

        // `generateAudio` is a Vertex-AI-only knob. The Gemini Developer API
        // (apiKey mode) rejects it outright and Veo 3.1 still generates audio
        // there, so only send the flag when the client is in Vertex mode.
        if (this.client.vertexai)
            veoConfig.generateAudio = true

        if (state.videoAspectRatio)
            veoConfig.aspectRatio = state.videoAspectRatio

        if (state.videoResolution)
            veoConfig.resolution = state.videoResolution

        if (state.videoDurationSeconds)
            veoConfig.durationSeconds = state.videoDurationSeconds

        if (generationConfig.negativePrompt)
            veoConfig.negativePrompt = generationConfig.negativePrompt

        // Video extension (Phase 6) is mutually exclusive with image/referenceImages
        // per the VEO API ("Not allowed if image is provided"). When the canvas
        // submits with sourceVideoNodeId set, the backend reads the existing MP4
        // bytes from the authorized Asset Blob and passes them as VEO's `video`
        // parameter. Extension takes precedence; first-frame + reference images
        // are skipped on this path.
        let extensionVideo: {
            videoBytes: string
            mimeType: string
        } | undefined

        if (state.videoSourceForExtension) {
            try {
                const bytes = await this.fetchObjectStoreBytes(state.videoSourceForExtension)

                if (
                    bytes
                    && bytes.length > 0
                )
                    extensionVideo = {
                        videoBytes: bytes.toString('base64'),
                        mimeType: 'video/mp4',
                    }
            } catch (e) {
                warn(`[Google:${this.instanceKey}] extension source load failed: ${(e as any)?.message ?? e}`)
            }
        }

        // Provided reference images are used as FRAME CONDITIONING ONLY — never as
        // asset/style references. The selected images arrive in a stable order via
        // videoFirstFrameImage (start frame) followed by videoReferenceImages
        // (the optional stop frame); we feed the first as VEO's `image` (start
        // frame) and the second as config.lastFrame (stop frame, first/last-frame
        // interpolation). When extension is active, both are suppressed.
        let firstFrameImage: VeoImageInput | undefined
        let lastFrameImage: VeoImageInput | undefined
        let duplicateFrameInputCount = 0

        if (!extensionVideo) {
            const rawFrameUrls = [state.videoFirstFrameImage, ...(state.videoReferenceImages ?? [])]
                .filter((url): url is string => typeof url === 'string' && url.length > 0)
            const frameUrls = [...new Set(rawFrameUrls)]
            duplicateFrameInputCount = rawFrameUrls.length - frameUrls.length

            if (frameUrls[0])
                firstFrameImage = this.dataUrlToImageBytes(frameUrls[0])

            if (frameUrls[1])
                lastFrameImage = this.dataUrlToImageBytes(frameUrls[1])
        }

        if (lastFrameImage)
            veoConfig.lastFrame = lastFrameImage

        const requiresEightSeconds = Boolean(extensionVideo || firstFrameImage || lastFrameImage)
            || veoConfig.resolution === '1080p'
            || veoConfig.resolution === '4k'

        if (requiresEightSeconds)
            veoConfig.durationSeconds = 8

        if (extensionVideo)
            veoConfig.resolution = '720p'

        const usesImageConditioning = !!firstFrameImage || !!lastFrameImage
        // VEO validates personGeneration by input mode: text-to-video and extension
        // require allow_all, while image/frame-conditioned requests require allow_adult.
        const configuredRegionProfile = process.env.GOOGLE_VEO_PERSON_GENERATION_PROFILE
        const regionProfile = configuredRegionProfile === 'restricted'
            || configuredRegionProfile === 'standard'
            ? configuredRegionProfile
            : undefined
        veoConfig = {
            ...veoConfig,
            ...this.deps.mediaProviderDefinition.moderation.settings(
                modelVersion,
                usesImageConditioning
                    ? 'image-conditioned'
                    : extensionVideo
                        ? 'video-extension'
                        : 'text',
                regionProfile ? { regionProfile } : undefined,
            ),
        }

        info(
            `[Google:${this.instanceKey}] VEO submit ${
                JSON.stringify(
                    {
                        model: modelVersion,
                        aspectRatio: veoConfig.aspectRatio,
                        resolution: veoConfig.resolution,
                        durationSeconds: veoConfig.durationSeconds,
                        personGeneration: veoConfig.personGeneration,
                        promptLen: prompt.length,
                        hasFirstFrame: !!firstFrameImage,
                        hasLastFrame: !!lastFrameImage,
                        firstFrameMimeType: firstFrameImage?.mimeType,
                        firstFrameBase64Length: firstFrameImage?.imageBytes.length ?? 0,
                        lastFrameMimeType: lastFrameImage?.mimeType,
                        lastFrameBase64Length: lastFrameImage?.imageBytes.length ?? 0,
                        duplicateFrameInputCount,
                        hasExtensionSource: !!extensionVideo,
                    },
                    null,
                    0,
                )
            }`,
        )

        try {
            await this.videoPub.pending()
            const startedAt = Date.now()
            let pollCount = 0

            const source: Record<string, any> = { prompt }
            const veoParams: Record<string, any> = {
                model: modelVersion,
                source,
                config: veoConfig,
            }

            // VEO precedence: extension > first-frame > reference-images > text-only.
            if (extensionVideo)
                source.video = extensionVideo
            else if (firstFrameImage)
                source.image = firstFrameImage

            // Nothing is published before the operation is accepted, so the
            // submit is safe to reattempt.
            let operation: any = await this.retryTransport('video', async () => await this.client.models.generateVideos(veoParams as any))
            info(
                `[Google:${this.instanceKey}] VEO operation accepted ${
                    JSON.stringify(
                        {
                            operationName: typeof operation?.name === 'string' ? operation.name : null,
                            done: operation?.done === true,
                            operationKeys: getObjectKeys(operation),
                            metadataKeys: getObjectKeys(operation?.metadata),
                            hasResponse: !!operation?.response,
                            hasError: !!operation?.error,
                        },
                        null,
                        0,
                    )
                }`,
            )

            while (!operation.done) {
                if (this.shouldStop)
                    throw new Error('Video generation aborted')

                await new Promise(resolve => setTimeout(resolve, VEO_POLL_INTERVAL_MS))

                if (this.shouldStop)
                    throw new Error('Video generation aborted')

                this.videoPub.generating()
                pollCount += 1
                // A blip while polling must not discard a video the provider is
                // already rendering — each poll is idempotent, so retry it.
                operation = await this.retryTransport(
                    'video-poll',
                    async () =>
                        await this.client.operations.getVideosOperation({
                            operation,
                            config: { abortSignal: this.signal } as any,
                        } as any),
                )

                if (
                    operation.done
                    || pollCount === 1
                    || pollCount % 6 === 0
                ) {
                    info(
                        `[Google:${this.instanceKey}] VEO poll ${
                            JSON.stringify(
                                {
                                    operationName: typeof operation?.name === 'string' ? operation.name : null,
                                    pollCount,
                                    elapsedMs: Date.now() - startedAt,
                                    done: operation?.done === true,
                                    hasResponse: !!operation?.response,
                                    hasError: !!operation?.error,
                                },
                                null,
                                0,
                            )
                        }`,
                    )
                }
            }

            const terminalSummary = getVeoOperationSummary(
                operation,
                pollCount,
                startedAt,
            )
            info(`[Google:${this.instanceKey}] VEO terminal operation ${JSON.stringify(
                terminalSummary,
                null,
                0,
            )}`)

            if (operation.error) {
                const opErr = operation.error
                const providerReason = typeof opErr === 'object'
                    && typeof opErr?.message === 'string'
                    ? opErr.message
                    : 'The provider operation failed.'
                const providerCode = typeof opErr === 'object'
                    ? opErr?.code ?? opErr?.status
                    : undefined

                throw new VeoOperationError(`VEO operation error: ${providerReason}`, providerCode !== undefined ? String(providerCode) : undefined)
            }

            const video = operation.response?.generatedVideos?.[0]?.video

            if (!video)
                throw new Error(
                    buildVeoNoVideoError(terminalSummary),
                )

            const videoBuffer = await this.fetchVideoBytes(video)

            if (
                !videoBuffer
                || videoBuffer.length === 0
            )
                throw new Error('VEO: empty video bytes after download')

            const durationSeconds = Number(state.videoDurationSeconds) || 0
            await this.videoPub.complete({
                videoBuffer,
                posterBuffer: null,
                frameBuffer: null,
                durationSeconds,
                aspectRatio: state.videoAspectRatio ?? '',
                hasAudio: true,
                responseId: typeof operation.name === 'string' ? operation.name : '',
                revisedPrompt: prompt,
                videoModelId: modelVersion,
            })
        } catch (e: any) {
            const message = e?.message ?? String(e)
            err(`[Google:${this.instanceKey}] VEO failed: ${message}`)

            // publisher may not be initialized
            try {
                this.videoPub.error(message)
            } catch {}

            throw e
        }
    }

    // Reads the API-resolved internal Blob Object Store URI for the source Asset
    // Object Store and returns the raw bytes. Used by the video-extension path
    // to load the source MP4 so VEO can extend it. Returns undefined when the
    // URI is malformed, the bucket is missing, or the object can't be fetched —
    // callers must treat that as "fall back to non-extension generation".
    private async fetchObjectStoreBytes(natsObjUri: string): Promise<Buffer | undefined> {
        const match = /^nats-obj:\/\/([^/]+)\/(.+)$/.exec(natsObjUri || '')

        if (!match) {
            warn(`[Google:${this.instanceKey}] unrecognized object-store URI: ${natsObjUri}`)

            return undefined
        }

        const bucket = match[1]!
        const objectKey = match[2]!

        try {
            const data = await this.nats.getObject(bucket, objectKey)

            if (!data)
                return undefined

            return Buffer.from(data)
        } catch (e: any) {
            warn(`[Google:${this.instanceKey}] getObject(${bucket}/${objectKey}) failed: ${e?.message ?? e}`)

            return undefined
        }
    }

    // Parses a `data:<mime>;base64,<payload>` URL into the SDK's Image_2 shape
    // (base64 imageBytes + mimeType). Returns undefined for non-data URLs so the
    // caller can fall back to text-to-video gracefully rather than throw.
    private dataUrlToImageBytes(dataUrl: string): {
        imageBytes: string
        mimeType: string
    } | undefined {
        if (
            !dataUrl
            || !dataUrl.startsWith('data:')
        )
            return undefined

        try {
            const {
                mediaType,
                base64,
            } = parseDataUrl(dataUrl)

            if (!base64)
                return undefined

            return {
                imageBytes: base64,
                mimeType: mediaType || 'image/png',
            }
        } catch (e) {
            warn(`[Google:${this.instanceKey}] dataUrlToImageBytes failed: ${e}`)

            return undefined
        }
    }

    // Returns MP4 bytes for a VEO Video object. The Gemini API normally returns
    // a `uri` (the file is hosted) — the SDK's files.download writes to disk, so
    // we download to a temp file and read it back. Some responses inline
    // `videoBytes` (base64); use that directly when present.
    private async fetchVideoBytes(video: {
        uri?: string
        videoBytes?: string
        mimeType?: string
    }): Promise<Buffer> {
        if (video.videoBytes)
            return Buffer.from(video.videoBytes, 'base64')

        if (!video.uri)
            throw new Error('VEO: generated video has neither videoBytes nor uri')

        let dir: string | undefined

        try {
            dir = await mkdtemp(
                join(
                    tmpdir(),
                    'veo-dl-',
                ),
            )
            const outPath = join(dir, 'video.mp4')
            // The video is already rendered and billed at this point; losing it
            // to a dropped download would be the worst possible moment to fail.
            await this.retryTransport(
                'video-download',
                async () =>
                    await this.client.files.download({
                        file: video as any,
                        downloadPath: outPath,
                    } as any),
            )

            return await readFile(outPath)
        } finally {
            if (dir) {
                try {
                    await rm(
                        dir,
                        {
                            recursive: true,
                            force: true,
                        },
                    )
                } catch {
                    // Best-effort cleanup of an isolated temporary download directory.
                }
            }
        }
    }
}

const mergeGoogleUsageMetadata = (
    first: any,
    second: any,
): any => {
    if (!first)
        return second

    if (!second)
        return first

    const numericKeys = [
        'promptTokenCount',
        'thoughtsTokenCount',
        'candidatesTokenCount',
        'cachedContentTokenCount',
        'totalTokenCount',
    ]
    const merged = {
        ...first,
        ...second,
    }

    for (const key of numericKeys)
        merged[key] = (first[key] ?? 0) + (second[key] ?? 0)

    return merged
}
