import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    directCapabilityToolName,
    SealedResolvedCapabilityPlan,
} from '@lixpi/capability-system/backend'
import {
    type AiModelInferenceCapabilities,
    type CapabilityManifest,
    type CapabilityResourceRef,
    type ResolvedCapabilityPlan,
} from '@lixpi/constants'

const openaiMocks = vi.hoisted(() => ({ responsesCreate: vi.fn() }))
const anthropicMocks = vi.hoisted(() => ({ messagesStream: vi.fn() }))
const debugTools = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    err: vi.fn(),
}))

vi.mock('@lixpi/debug-tools', () => debugTools)
vi.mock('openai', () => ({
    default: class {
        responses = { create: openaiMocks.responsesCreate }
        images = { generate: vi.fn() }
    },
    toFile: vi.fn(),
}))
vi.mock('@anthropic-ai/sdk', () => ({
    default: class {
        messages = {
            stream: anthropicMocks.messagesStream,
            create: vi.fn(),
        }
    },
}))

import {
    type BaseProviderDeps,
} from './base-provider.ts'
import { AnthropicProvider } from './anthropic-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'

const asyncStream = <T>(items: T[]): AsyncIterable<T> => {
    return {
        [Symbol.asyncIterator]: async function*() {
            for (const item of items) yield item
        },
    }
}

const deps = (search: ReturnType<typeof vi.fn>): BaseProviderDeps => {
    return {
        natsService: { publish: vi.fn() } as any,
        usageReporter: {} as any,
        runImageRouter: vi.fn(),
        runVideoRouter: vi.fn(),
        capabilityDispatcher: {
            search,
            use: vi.fn(),
        } as any,
    }
}

const capabilityRunResult = () => {
    return {
        run: {
            runId: 'run-1',
            rootCapabilityId: 'character-creator',
            resolvedManifests: [],
            workspaceId: 'workspace-1',
            origin: 'model',
            status: 'completed',
            currentStepIds: [],
            outputAssetIds: ['asset-1'],
            eventStreamName: 'CAPABILITY_RUN_EVENTS_workspace-1',
            createdAt: 1,
            updatedAt: 2,
        },
        output: { assetId: 'asset-1' },
        stepOutputs: {},
    }
}

const actionTimelinePlan = (): SealedResolvedCapabilityPlan => {
    const schemaRef: CapabilityResourceRef = {
        resourceId: 'input',
        blobHash: 'input-hash',
        mediaType: 'application/schema+json',
        role: 'schema',
    }
    const manifest: CapabilityManifest = {
        schemaVersion: 1,
        capabilityId: 'action-timeline',
        kind: 'tool',
        name: 'Action Timeline',
        description: 'Create a timed action timeline.',
        references: [],
        resources: [schemaRef],
        tool: {
            toolType: 'action-timeline',
            inputSchema: schemaRef,
            outputSchema: schemaRef,
            executionPolicy: 'model-required',
            executionMultiplicity: 'per-reasoning-model',
            modelAxisPolicy: {
                reasoning: 'all-selected',
                image: 'ignore',
                video: 'ignore',
                outputMode: 'capability-only',
            },
            workflow: {
                steps: [],
                outputs: {},
            },
        },
    }
    const serializable: ResolvedCapabilityPlan = {
        rootCapabilityIds: ['action-timeline'],
        capabilities: [{
            capabilityId: 'action-timeline',
            kind: 'tool',
            manifestBlobHash: 'manifest-hash',
            manifest,
        }],
        resolvedManifests: [{
            capabilityId: 'action-timeline',
            manifestBlobHash: 'manifest-hash',
        }],
    }

    return new SealedResolvedCapabilityPlan(serializable, [{
        capabilityId: 'action-timeline',
        ref: schemaRef,
        bytes: new TextEncoder().encode(JSON.stringify({
            type: 'object',
            required: ['durationMs', 'precisionMs'],
            properties: {
                durationMs: { type: 'number' },
                precisionMs: { type: 'number' },
            },
            additionalProperties: false,
        })),
    }])
}

const configure = (provider: OpenAIProvider | AnthropicProvider) => {
    const publisher = {
        start: vi.fn(),
        end: vi.fn(),
        chunk: vi.fn(),
        error: vi.fn(),
        capabilityGenerationTrace: vi.fn(),
    }
    ;(provider as any).streamPublisher = publisher
    ;(provider as any).imagePublisher = {
        partial: vi.fn(),
        complete: vi.fn(),
    }
    ;(provider as any).videoPublisher = {
        pending: vi.fn(),
        generating: vi.fn(),
        complete: vi.fn(),
        error: vi.fn(),
    }
    ;(provider as any).abortController = new AbortController()

    return publisher
}

const inferenceCapabilities = (provider: 'OpenAI' | 'Anthropic'): AiModelInferenceCapabilities => ({
    thinkingMode: 'none',
    requiresAutoToolChoiceWithThinking: false,
    supportsTemperature: provider !== 'OpenAI',
    supportsSystemPrompt: true,
    requiresClosedJsonSchema: provider === 'OpenAI',
    supportedInputKinds: ['image', 'video-frame', 'document-text'],
})

const state = (provider: 'OpenAI' | 'Anthropic') => {
    return {
        workspaceId: 'workspace-1',
        aiChatThreadId: 'thread-1',
        messages: [{
            role: 'user',
            content: 'Find a character Tool',
        }],
        modelVersion: provider === 'OpenAI' ? 'gpt-5' : 'claude-sonnet-4-5',
        aiModelMetaInfo: {
            modelVersion: provider === 'OpenAI' ? 'gpt-5' : 'claude-sonnet-4-5',
            inferenceCapabilities: inferenceCapabilities(provider),
        },
        maxCompletionSize: 1000,
        temperature: 0.7,
        eventMeta: {
            userId: 'user-1',
            organizationId: 'organization-1',
        },
        capabilityInvocationDepth: 0,
    }
}

const actionTimelineState = (provider: 'OpenAI' | 'Anthropic') => {
    const base = state(provider)

    return {
        ...base,
        provider,
        resolvedCapabilityPlan: actionTimelinePlan(),
        capabilityInputs: {
            'action-timeline': {
                prompt: 'Create a 15 second timeline with 2 second gaps',
                durationMs: 15000,
                precisionMs: 2000,
            },
        },
        generationRun: {
            requestKind: 'media-generation-matrix',
            generationRequestId: 'request-1',
            reasoningRunId: 'reasoning-1',
            reasoningModelId: `${provider}:${base.modelVersion}`,
            reasoningIndex: 0,
        },
    }
}

describe('Capability provider adapters', () => {
    beforeEach(() => {
        process.env.OPENAI_API_KEY = 'test'
        process.env.ANTHROPIC_API_KEY = 'test'
        openaiMocks.responsesCreate.mockReset()
        anthropicMocks.messagesStream.mockReset()
    })

    afterEach(() => {
        delete process.env.OPENAI_API_KEY
        delete process.env.ANTHROPIC_API_KEY
    })

    it('continues OpenAI Responses after a Capability search function result', async () => {
        openaiMocks.responsesCreate
            .mockResolvedValueOnce(asyncStream([{
                type: 'response.completed',
                response: {
                    id: 'response-1',
                    output: [{
                        type: 'function_call',
                        call_id: 'call-1',
                        name: 'search_capabilities',
                        arguments: '{"query":"character"}',
                    }],
                    usage: {
                        input_tokens: 2,
                        output_tokens: 1,
                    },
                },
            }]))
            .mockResolvedValueOnce(asyncStream([
                {
                    type: 'response.output_text.delta',
                    delta: 'Found it.',
                },
                {
                    type: 'response.completed',
                    response: {
                        id: 'response-2',
                        output: [],
                        usage: {
                            input_tokens: 3,
                            output_tokens: 4,
                        },
                    },
                },
            ]))
        const search = vi.fn(async () => ({ items: [] }))
        const provider = new OpenAIProvider('instance', deps(search))
        const publisher = configure(provider)

        const update = await (provider as any).streamImpl(state('OpenAI'))

        expect(search).toHaveBeenCalledOnce()
        expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2)
        expect(openaiMocks.responsesCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            tools: expect.arrayContaining([
                expect.objectContaining({ name: 'search_capabilities' }),
                expect.objectContaining({ name: 'use_capability' }),
            ]),
        }))
        expect(openaiMocks.responsesCreate.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            input: expect.arrayContaining([
                expect.objectContaining({
                    type: 'function_call_output',
                    call_id: 'call-1',
                }),
            ]),
        }))
        expect(publisher.chunk).toHaveBeenCalledWith('Found it.')
        expect(update.usage).toEqual(expect.objectContaining({ totalTokens: 10 }))
    })

    it('continues Anthropic Messages after a Capability tool_result', async () => {
        const firstFinal = {
            id: 'message-1',
            content: [{
                type: 'tool_use',
                id: 'tool-1',
                name: 'search_capabilities',
                input: { query: 'character' },
            }],
            usage: {
                input_tokens: 2,
                output_tokens: 1,
            },
        }
        const secondFinal = {
            id: 'message-2',
            content: [{
                type: 'text',
                text: 'Found it.',
            }],
            usage: {
                input_tokens: 3,
                output_tokens: 4,
            },
        }
        anthropicMocks.messagesStream
            .mockReturnValueOnce({
                ...asyncStream([]),
                finalMessage: vi.fn(async () => firstFinal),
            })
            .mockReturnValueOnce({
                ...asyncStream([{
                    type: 'content_block_delta',
                    delta: {
                        type: 'text_delta',
                        text: 'Found it.',
                    },
                }]),
                finalMessage: vi.fn(async () => secondFinal),
            })
        const search = vi.fn(async () => ({ items: [] }))
        const provider = new AnthropicProvider('instance', deps(search))
        const publisher = configure(provider)

        const update = await (provider as any).streamImpl(state('Anthropic'))

        expect(search).toHaveBeenCalledOnce()
        expect(anthropicMocks.messagesStream).toHaveBeenCalledTimes(2)
        expect(anthropicMocks.messagesStream.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            tools: expect.arrayContaining([
                expect.objectContaining({ name: 'search_capabilities' }),
                expect.objectContaining({ name: 'use_capability' }),
            ]),
        }))
        expect(anthropicMocks.messagesStream.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            messages: expect.arrayContaining([
                expect.objectContaining({
                    role: 'user',
                    content: [expect.objectContaining({
                        type: 'tool_result',
                        tool_use_id: 'tool-1',
                    })],
                }),
            ]),
        }))
        expect(publisher.chunk).toHaveBeenCalledWith('Found it.')
        expect(update.usage).toEqual(expect.objectContaining({ totalTokens: 10 }))
    })

    it('forces Action Timeline once in Anthropic and streams the agent response after its tool result', async () => {
        const toolName = directCapabilityToolName('action-timeline')
        const firstFinal = {
            id: 'message-1',
            content: [{
                type: 'tool_use',
                id: 'tool-1',
                name: toolName,
                input: {
                    durationMs: 1,
                    precisionMs: 1,
                },
            }],
            usage: {
                input_tokens: 2,
                output_tokens: 1,
            },
        }
        const secondFinal = {
            id: 'message-2',
            content: [{
                type: 'text',
                text: 'The action timeline is ready.',
            }],
            usage: {
                input_tokens: 3,
                output_tokens: 4,
            },
        }
        anthropicMocks.messagesStream
            .mockReturnValueOnce({
                ...asyncStream([]),
                finalMessage: vi.fn(async () => firstFinal),
            })
            .mockReturnValueOnce({
                ...asyncStream([{
                    type: 'content_block_delta',
                    delta: {
                        type: 'text_delta',
                        text: 'The action timeline is ready.',
                    },
                }]),
                finalMessage: vi.fn(async () => secondFinal),
            })
        const use = vi.fn(async () => ({
            ...capabilityRunResult(),
            output: {
                outputKind: 'capabilityArtifact',
                assetId: 'asset-1',
            },
            events: [],
        }))
        const provider = new AnthropicProvider('instance', {
            ...deps(vi.fn()),
            capabilityDispatcher: { use } as any,
        })
        const publisher = configure(provider)

        await (provider as any).streamImpl(actionTimelineState('Anthropic'))

        expect(anthropicMocks.messagesStream).toHaveBeenCalledTimes(2)
        expect(anthropicMocks.messagesStream.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            tool_choice: {
                type: 'tool',
                name: toolName,
            },
            tools: expect.arrayContaining([expect.objectContaining({ name: toolName })]),
        }))
        expect(anthropicMocks.messagesStream.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            messages: expect.arrayContaining([
                expect.objectContaining({
                    role: 'user',
                    content: [expect.objectContaining({
                        type: 'tool_result',
                        tool_use_id: 'tool-1',
                    })],
                }),
            ]),
        }))
        expect(anthropicMocks.messagesStream.mock.calls[1]?.[0]?.tool_choice).toBeUndefined()
        expect(anthropicMocks.messagesStream.mock.calls[1]?.[0]?.tools).toBeUndefined()
        expect(anthropicMocks.messagesStream.mock.calls[1]?.[0]?.system).toContain('Do not include code')
        expect(anthropicMocks.messagesStream.mock.calls[0]?.[0]?.system).not.toContain('Do not include code')
        expect(use).toHaveBeenCalledWith(expect.objectContaining({
            arguments: expect.objectContaining({
                durationMs: 15000,
                precisionMs: 2000,
            }),
        }))
        expect(publisher.capabilityGenerationTrace).toHaveBeenCalledOnce()
        expect(publisher.chunk).toHaveBeenCalledWith('The action timeline is ready.')
        expect(publisher.end).not.toHaveBeenCalled()
    })

    it('dispatches use_capability visibly and returns its run output to OpenAI', async () => {
        openaiMocks.responsesCreate
            .mockResolvedValueOnce(asyncStream([{
                type: 'response.completed',
                response: {
                    id: 'response-1',
                    output: [{
                        type: 'function_call',
                        call_id: 'call-1',
                        name: 'use_capability',
                        arguments: JSON.stringify({
                            capabilityId: 'character-creator',
                            arguments: { prompt: 'desert courier' },
                        }),
                    }],
                    usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                    },
                },
            }]))
            .mockResolvedValueOnce(asyncStream([{
                type: 'response.completed',
                response: {
                    id: 'response-2',
                    output: [],
                    usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                    },
                },
            }]))
        const use = vi.fn(async () => capabilityRunResult())
        const provider = new OpenAIProvider('instance', {
            ...deps(vi.fn(async () => ({ items: [] }))),
            capabilityDispatcher: {
                search: vi.fn(),
                use,
            } as any,
        })
        configure(provider)

        await (provider as any).streamImpl(state('OpenAI'))

        expect(use).toHaveBeenCalledWith(expect.objectContaining({
            capabilityId: 'character-creator',
            arguments: { prompt: 'desert courier' },
            origin: 'model',
            invocationDepth: 0,
        }))
        const continuationInput = openaiMocks.responsesCreate.mock.calls[1]?.[0]?.input
        const output = continuationInput.find((item: any) => item.type === 'function_call_output')
        expect(JSON.parse(output.output)).toEqual(expect.objectContaining({
            runId: 'run-1',
            status: 'completed',
            outputAssetIds: ['asset-1'],
        }))
    })

    it('forces Action Timeline once in OpenAI and streams the agent response after its function output', async () => {
        const toolName = directCapabilityToolName('action-timeline')
        openaiMocks.responsesCreate
            .mockResolvedValueOnce(asyncStream([{
                type: 'response.completed',
                response: {
                    id: 'response-1',
                    output: [{
                        type: 'function_call',
                        call_id: 'call-1',
                        name: toolName,
                        arguments: JSON.stringify({
                            durationMs: 1,
                            precisionMs: 1,
                        }),
                    }],
                    usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                    },
                },
            }]))
            .mockResolvedValueOnce(asyncStream([
                {
                    type: 'response.output_text.delta',
                    delta: 'The action timeline is ready.',
                },
                {
                    type: 'response.completed',
                    response: {
                        id: 'response-2',
                        output: [],
                        usage: {
                            input_tokens: 1,
                            output_tokens: 1,
                        },
                    },
                },
            ]))
        const use = vi.fn(async () => ({
            ...capabilityRunResult(),
            output: {
                outputKind: 'capabilityArtifact',
                assetId: 'asset-1',
            },
            events: [],
        }))
        const provider = new OpenAIProvider('instance', {
            ...deps(vi.fn()),
            capabilityDispatcher: { use } as any,
        })
        const publisher = configure(provider)

        await (provider as any).streamImpl(actionTimelineState('OpenAI'))

        expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2)
        expect(openaiMocks.responsesCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            tool_choice: {
                type: 'function',
                name: toolName,
            },
            tools: expect.arrayContaining([expect.objectContaining({ name: toolName })]),
        }))
        expect(openaiMocks.responsesCreate.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            input: expect.arrayContaining([
                expect.objectContaining({
                    type: 'function_call_output',
                    call_id: 'call-1',
                }),
            ]),
        }))
        expect(openaiMocks.responsesCreate.mock.calls[1]?.[0]?.tool_choice).toBeUndefined()
        expect(openaiMocks.responsesCreate.mock.calls[1]?.[0]?.tools).toBeUndefined()
        expect(openaiMocks.responsesCreate.mock.calls[1]?.[0]?.instructions).toContain('Do not include code')
        expect(openaiMocks.responsesCreate.mock.calls[0]?.[0]?.instructions).not.toContain('Do not include code')
        expect(use).toHaveBeenCalledWith(expect.objectContaining({
            arguments: expect.objectContaining({
                durationMs: 15000,
                precisionMs: 2000,
            }),
        }))
        expect(publisher.capabilityGenerationTrace).toHaveBeenCalledOnce()
        expect(publisher.chunk).toHaveBeenCalledWith('The action timeline is ready.')
        expect(publisher.end).not.toHaveBeenCalled()
    })
})
