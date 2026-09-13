import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    NATS_SUBJECTS,
    STREAM_STATUS,
    getAiInteractionResponseSubject,
} from '@lixpi/constants'
import AiInteractionService from '$src/services/ai-interaction-service.ts'

const { AI_INTERACTION_SUBJECTS } = NATS_SUBJECTS

const workspaceId = 'workspace-1'
const organizationId = 'org-1'
const conversationAssetId = 'thread-1'
const userId = 'user-1'
const responseSubject = getAiInteractionResponseSubject(userId, organizationId, conversationAssetId)

const getDataMock = vi.hoisted(() => vi.fn())
const natsPublishMock = vi.hoisted(() => vi.fn())
const natsSubscribeMock = vi.hoisted(() => vi.fn())
const natsGetSubscriptionsMock = vi.hoisted(() => vi.fn())
const natsRequestMock = vi.hoisted(() => vi.fn())
const getTokenSilentlyMock = vi.hoisted(() => vi.fn())
const receiveSegmentMock = vi.hoisted(() => vi.fn())
const uuidMock = vi.hoisted(() => vi.fn(() => 'matrix-request-id'))
const userGetMock = vi.hoisted(() => vi.fn())
const onErrorMock = vi.hoisted(() => vi.fn())

let consoleErrorSpy: { mockRestore: () => void } | null = null
let consoleLogSpy: { mockRestore: () => void } | null = null
let consoleWarnSpy: { mockRestore: () => void } | null = null

const flushPromises = async (): Promise<void> => void (await new Promise(resolve => setTimeout(resolve, 0)))

vi.mock('uuid', () => ({ v4: uuidMock }))

vi.mock('$src/services/segmentsReceiver-service.ts', () => ({
    default: {
        receiveSegment: receiveSegmentMock,
    },
}))

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: {
        getData: getDataMock,
    },
}))

const auth = { getTokenSilently: getTokenSilentlyMock }
const userStore = { getData: userGetMock } as never

describe('AiInteractionService', () => {
    let service: AiInteractionService

    beforeEach(async () => {
        vi.clearAllMocks()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        getDataMock.mockReturnValue({
            publish: natsPublishMock,
            subscribe: natsSubscribeMock,
            getSubscriptions: natsGetSubscriptionsMock,
            request: natsRequestMock,
        })
        getTokenSilentlyMock.mockResolvedValue('auth-token')
        userGetMock.mockReturnValue(userId)
        natsGetSubscriptionsMock.mockReturnValue([])
        natsSubscribeMock.mockImplementation(() => ({ unsubscribe: vi.fn() }))
        natsRequestMock.mockResolvedValue({ events: [] })

        service = new AiInteractionService({
            auth,
            workspaceId,
            conversationAssetId,
            organizationId,
            onError: onErrorMock,
            userStore,
        })

        await flushPromises()
    })

    afterEach(() => {
        service?.disconnect()
        consoleErrorSpy?.mockRestore()
        consoleLogSpy?.mockRestore()
        consoleWarnSpy?.mockRestore()
        consoleErrorSpy = null
        consoleLogSpy = null
        consoleWarnSpy = null
    })

    it('subscribes to thread responses and resumes pipeline events', async () => {
        await flushPromises()

        expect(getDataMock).toHaveBeenCalledWith('nats')
        expect(natsGetSubscriptionsMock).not.toHaveBeenCalled()
        expect(natsSubscribeMock).toHaveBeenCalledWith(responseSubject, expect.any(Function))
        expect(natsRequestMock).toHaveBeenCalledWith(
            AI_INTERACTION_SUBJECTS.CHAT_PIPELINE_RESUME,
            expect.objectContaining({
                token: 'auth-token',
                workspaceId,
                conversationAssetId,
                localStreamSeq: 0,
            }),
        )
    })

    it('computes run keys, chat subject, and generation-run detection', () => {
        expect(service.getRunKey({ reasoningRunId: 'reasoning-run' } as any)).toBe('reasoning-run')
        expect(service.getRunKey()).toBe(conversationAssetId)
        expect(service.getGenerationRun({ generationRun: { reasoningRunId: 'trace-run' } } as any)).toEqual({ reasoningRunId: 'trace-run' })
        expect(service.getGenerationRun({ imageGenerationTrace: { generationRun: { reasoningRunId: 'image-run' } } } as any)).toEqual({ reasoningRunId: 'image-run' })
        expect(service.getGenerationRun({ videoGenerationTrace: { generationRun: { reasoningRunId: 'video-run' } } } as any)).toEqual({ reasoningRunId: 'video-run' })
        expect(service.getGenerationRun({ capabilityGenerationTrace: { generationRun: { reasoningRunId: 'capability-run' } } } as any)).toEqual({ reasoningRunId: 'capability-run' })
        expect(service.getChatResponseSubject()).toBe(responseSubject)
    })

    it('reports a top-level API rejection to its owner without forwarding a segment', () => {
        service.onChatMessageResponse({ error: 'ACTION_TIMELINE_DURATION_AND_PRECISION_REQUIRED' })

        expect(onErrorMock).toHaveBeenCalledOnce()
        expect(onErrorMock).toHaveBeenCalledWith('ACTION_TIMELINE_DURATION_AND_PRECISION_REQUIRED')
        expect(receiveSegmentMock).not.toHaveBeenCalled()
    })

    it('accepts durable media request acknowledgments without reporting missing chat content', () => {
        service.onChatMessageResponse({
            generationRequestId: 'media-request-1',
            status: 'submitted',
            requestRevision: 1,
            mediaEventSubject: 'ai.interaction.mediaGeneration.status.user.workspace.media-request-1',
        })

        expect(console.error).not.toHaveBeenCalled()
        expect(onErrorMock).not.toHaveBeenCalled()
        expect(receiveSegmentMock).not.toHaveBeenCalled()
    })

    it('tracks provider per run key and falls back when events omit aiProvider', () => {
        service.updateRunProvider('reasoning-run', 'provider-A')

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.IMAGE_PARTIAL,
                generationRun: { reasoningRunId: 'reasoning-run' },
                imageUrl: 'https://images.example/one.png',
                assetId: 'asset-1',
                partialIndex: 0,
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.IMAGE_PARTIAL,
                generationRun: { reasoningRunId: 'reasoning-run' },
                imageUrl: 'https://images.example/two.png',
                assetId: 'asset-2',
                partialIndex: 1,
            },
        })

        expect(receiveSegmentMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                type: 'image_partial',
                imageUrl: 'https://images.example/one.png',
                aiProvider: 'provider-A',
                generationRun: { reasoningRunId: 'reasoning-run' },
            }),
        )
        expect(receiveSegmentMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                type: 'image_partial',
                imageUrl: 'https://images.example/two.png',
                aiProvider: 'provider-A',
            }),
        )
        expect(service.updateRunProvider('reasoning-run')).toBe('provider-A')
    })

    it('deduplicates pipeline events using pipelineEventId and advances stream cursor', () => {
        service.onChatMessageResponse({
            pipelineEventId: 'event-1',
            pipelineStreamSeq: 3,
            content: {
                status: STREAM_STATUS.IMAGE_PARTIAL,
                imageUrl: 'first',
                assetId: 'asset-1',
                partialIndex: 1,
            },
        })

        service.onChatMessageResponse({
            pipelineEventId: 'event-1',
            pipelineStreamSeq: 2,
            content: {
                status: STREAM_STATUS.IMAGE_PARTIAL,
                imageUrl: 'duplicate',
                assetId: 'asset-2',
                partialIndex: 2,
            },
        })

        expect(receiveSegmentMock).toHaveBeenCalledTimes(1)
        expect(service.pipelineLocalStreamSeq).toBe(3)
    })

    it('handles context relevance events and image/media branches', () => {
        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.CONTEXT_RELEVANCE_RESOLVED,
                workspaceContextResolution: {
                    selections: [{ nodeId: 'node-1' }],
                    improvedDescriptors: {},
                    narrowedMediaNodeIds: ['image-1'],
                },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.MEDIA_BRANCH_RESOLVED,
                resolution: { target: 'node-1' },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.MEDIA_LINEAGE_PLANNED,
                lineagePlan: {
                    generationRequestId: 'lineage-1',
                    branchForks: [],
                    runAssignments: [],
                },
            },
        })

        expect(receiveSegmentMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'context_relevance_resolved',
                workspaceContextResolution: expect.objectContaining({
                    selections: [{ nodeId: 'node-1' }],
                }),
            }),
        )
        expect(receiveSegmentMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'image_branch_resolved',
                mediaBranchResolution: expect.objectContaining({ target: 'node-1' }),
            }),
        )
        expect(receiveSegmentMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'media_lineage_planned',
                mediaBranchLineagePlan: expect.objectContaining({
                    generationRequestId: 'lineage-1',
                }),
            }),
        )
    })

    it('maps image and video status events to dedicated segment kinds', () => {
        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.IMAGE_COMPLETE,
                imageUrl: 'https://img.example/final.png',
                assetId: 'asset-final',
                responseId: 'img-response',
                revisedPrompt: 'sunset',
                aiProvider: 'image-provider',
                generationRun: { reasoningRunId: 'run-image' },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.VIDEO_PENDING,
                generationRun: { reasoningRunId: 'run-video' },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.VIDEO_GENERATING,
                generationRun: { reasoningRunId: 'run-video' },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.VIDEO_COMPLETE,
                videoUrl: 'https://vid.example/final.mp4',
                assetId: 'video-asset',
                responseId: 'video-response',
                revisedPrompt: 'city',
                durationSeconds: 9,
                aspectRatio: '16:9',
                hasAudio: true,
                generationRun: { reasoningRunId: 'run-video' },
                aiProvider: 'video-provider',
                videoModelId: 'v-model',
                videoModelProvider: 'provider-X',
            },
        })

        expect(receiveSegmentMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'image_complete',
            assetId: 'asset-final',
            responseId: 'img-response',
            revisedPrompt: 'sunset',
            aiProvider: 'image-provider',
            generationRun: { reasoningRunId: 'run-image' },
        }))
        expect(receiveSegmentMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'video_complete',
            assetId: 'video-asset',
            responseId: 'video-response',
            videoModel: 'v-model',
            videoModelProvider: 'provider-X',
            hasAudio: true,
            durationSeconds: 9,
        }))
    })

    it('maps Capability generation traces into the authoritative chat history stream', () => {
        const generationRun = {
            requestKind: 'media-generation-matrix',
            generationRequestId: 'request-1',
            reasoningRunId: 'reasoning-1',
            reasoningModelId: 'Anthropic:claude-haiku-4-5',
            reasoningIndex: 0,
        }
        const capabilityGenerationTrace = {
            traceVersion: 'capability-generation-trace-v1',
            generationRun,
            capabilityId: 'action-timeline',
            capabilityName: 'Action Timeline',
            capabilityRunId: 'timeline-run',
            chatModelProvider: 'Anthropic',
            chatModelId: 'Anthropic:claude-haiku-4-5',
            input: {
                durationMs: 15000,
                precisionMs: 2000,
            },
            outputAssetIds: ['timeline-asset'],
            steps: [],
        }

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.CAPABILITY_GENERATION_TRACE,
                aiProvider: 'Anthropic',
                capabilityGenerationTrace,
            },
        })

        expect(receiveSegmentMock).toHaveBeenCalledWith({
            type: 'capability_generation_trace',
            workspaceId,
            capabilityGenerationTrace,
            aiProvider: 'Anthropic',
            conversationAssetId,
            usesServerProseMirror: true,
            generationRun,
        })
    })

    it('logs and does not create segments when the transport reports an error', () => {
        service.onChatMessageResponse({ error: { message: 'transport failed' } })

        expect(consoleErrorSpy).toHaveBeenCalledWith('[AI_INTERACTION] Failed to receive chat message:', { message: 'transport failed' })
        expect(receiveSegmentMock).not.toHaveBeenCalled()
    })

    it('replays pipeline resume events through the same handling path', async () => {
        natsRequestMock
            .mockReset()
            .mockResolvedValue({
                events: [
                    {
                        eventId: 'replay-1',
                        streamSequence: 4,
                        payload: {
                            pipelineEventId: 'replay-1',
                            pipelineStreamSeq: 4,
                            content: {
                                status: STREAM_STATUS.VIDEO_ERROR,
                                error: 'frame dropped',
                            },
                        },
                    },
                    {
                        eventId: 'replay-3',
                        streamSequence: 11,
                        payload: {
                            pipelineEventId: 'replay-3',
                            pipelineStreamSeq: 11,
                            content: {
                                status: STREAM_STATUS.MEDIA_GENERATION_REQUEST_COMPLETE,
                                generationRequestId: 'request-complete-resume',
                                generationRun: {
                                    generationRequestId: 'request-complete-resume',
                                    reasoningRunId: 'run-image',
                                },
                            },
                        },
                    },
                    {
                        eventId: 'replay-2',
                        streamSequence: 9,
                        payload: {
                            pipelineEventId: 'replay-2',
                            pipelineStreamSeq: 9,
                            content: {
                                status: STREAM_STATUS.MEDIA_GENERATION_SKIPPED,
                                generationRequestId: 'media-req',
                            },
                        },
                    },
                ],
            })

        await service.resumePipelineEventStream()

        expect(natsRequestMock).toHaveBeenLastCalledWith(
            AI_INTERACTION_SUBJECTS.CHAT_PIPELINE_RESUME,
            expect.objectContaining({
                token: 'auth-token',
                workspaceId,
                conversationAssetId,
                localStreamSeq: 0,
            }),
        )
        expect(receiveSegmentMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'video_error',
            error: 'frame dropped',
        }))
        expect(receiveSegmentMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'media_generation_request_complete',
            generationRequestId: 'request-complete-resume',
        }))
        expect(receiveSegmentMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'media_generation_skipped',
            generationRequestId: 'media-req',
        }))
        expect(service.pipelineLocalStreamSeq).toBe(11)
    })

    it('ignores text-only streaming status payloads', () => {
        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.START_STREAM,
                aiProvider: 'provider',
                generationRun: { reasoningRunId: 'text-run' },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.STREAMING,
                text: 'hello world',
                generationRun: { reasoningRunId: 'text-run' },
            },
        })

        service.onChatMessageResponse({
            content: {
                status: STREAM_STATUS.END_STREAM,
                generationRun: { reasoningRunId: 'text-run' },
            },
        })

        expect(receiveSegmentMock).not.toHaveBeenCalled()
    })

    it('collapses model selections when multiple-mode is disabled', async () => {
        await service.sendChatMessage({
            aiReasoningModels: ['reasoner-a', 'reasoner-b'],
            useMultipleReasoningModels: false,
            aiImageModels: ['image-a', 'image-b'],
            imageSize: '1024x1024',
            useMultipleImageModels: false,
            aiVideoModels: ['video-a'],
            videoResolution: '1080p',
            videoDuration: '6',
            useMultipleVideoModels: false,
        })

        const payload = natsPublishMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
        expect(payload.aiReasoningModels).toEqual(['reasoner-a'])
        expect(payload.aiImageModels).toEqual(['image-a'])
        expect(payload.aiVideoModels).toEqual(['video-a'])
        expect(payload.imageSize).toBe('1024x1024')
        expect(payload.videoResolution).toBe('1080p')
        expect(payload).not.toHaveProperty('mediaGenerationRequest')
    })

    it('sends media matrix payload when multi-model mode is enabled', async () => {
        await service.sendChatMessage({
            aiReasoningModels: ['reasoner-a', 'reasoner-b'],
            useMultipleReasoningModels: true,
            reasoningConfigGroups: [{
                groupId: 'effort',
                modelIds: [],
                values: { reasoningEffort: 'high' },
            }],
            aiImageModels: ['image-a', 'image-b'],
            imageSize: '768x768',
            imageConfigGroups: [{
                groupId: 'size',
                modelIds: [],
                values: {},
            }],
            useMultipleImageModels: true,
            aiVideoModels: ['video-a', 'video-b'],
            videoAspectRatio: '16:9',
            videoResolution: '720p',
            videoDuration: '6',
            videoSourceForExtension: 's3://video-source',
            useMultipleVideoModels: true,
            videoConfigGroups: [{
                groupId: 'quality',
                modelIds: [],
                values: {},
            }],
            mediaBranchCandidateSnapshot: {
                resolverVersion: 'image-branch-v1',
                conversationAssetId,
                regionNodeId: 'node-1',
                promptText: 'film',
                candidates: [],
                promptFingerprint: 'fingerprint-1',
                transcriptContext: 'context',
            },
            workspaceContextSnapshot: {
                resolverVersion: 'workspace-context-v1',
                workspaceId,
                conversationAssetId,
                promptText: 'film',
                nodes: [],
            },
            canvasVisibleArea: {
                width: 5,
                height: 6,
            },
        })

        const payload = natsPublishMock.mock.calls.at(-1)?.[1] as Record<string, unknown>
        expect(payload).toMatchObject({
            aiReasoningModels: ['reasoner-a', 'reasoner-b'],
            aiImageModels: ['image-a', 'image-b'],
            aiVideoModels: ['video-a', 'video-b'],
            imageSize: '768x768',
            mediaBranchCandidateSnapshot: {
                resolverVersion: 'image-branch-v1',
                conversationAssetId,
            },
            workspaceContextSnapshot: {
                workspaceId,
                nodes: [],
            },
            mediaGenerationRequest: {
                requestVersion: 'media-generation-matrix-v1',
                generationRequestId: 'matrix-request-id',
                reasoningModelIds: ['reasoner-a', 'reasoner-b'],
                reasoningOptions: {
                    configGroups: [{
                        groupId: 'effort',
                        modelIds: [],
                        values: { reasoningEffort: 'high' },
                    }],
                },
                imageModelIds: ['image-a', 'image-b'],
                videoModelIds: ['video-a', 'video-b'],
                imageOptions: {
                    imageSize: '768x768',
                    configGroups: [{
                        groupId: 'size',
                        modelIds: [],
                        values: {},
                    }],
                },
                videoOptions: {
                    aspectRatio: '16:9',
                    resolution: '720p',
                    duration: '6',
                    sourceForExtension: 's3://video-source',
                    configGroups: [{
                        groupId: 'quality',
                        modelIds: [],
                        values: {},
                    }],
                },
            },
            canvasVisibleArea: {
                width: 5,
                height: 6,
            },
            organizationId,
        })
        expect(payload).not.toHaveProperty('capabilityReferences')
        expect(payload).not.toHaveProperty('messages')
        expect(payload.token).toBe('auth-token')
    })

    it('reuses the browser-owned generation request id for submission and matrix routing', async () => {
        await service.sendChatMessage({
            generationRequestId: 'media-browser-request',
            aiReasoningModels: ['reasoner-a'],
            useMultipleReasoningModels: true,
            aiImageModels: ['image-a', 'image-b'],
            useMultipleImageModels: true,
            aiVideoModels: [],
            useMultipleVideoModels: false,
        })

        const payload = natsPublishMock.mock.calls.at(-1)?.[1] as Record<string, any>
        expect(payload.generationRequestId).toBe('media-browser-request')
        expect(payload.mediaGenerationRequest?.generationRequestId).toBe('media-browser-request')
        expect(uuidMock).not.toHaveBeenCalled()
    })

    it('excludes a disabled scalar video model from image matrix planning', async () => {
        await service.sendChatMessage({
            aiReasoningModels: ['reasoner-a'],
            useMultipleReasoningModels: false,
            aiImageModels: ['image-a', 'image-b'],
            imageSize: '768x768',
            useMultipleImageModels: true,
            aiVideoModels: ['video-a'],
            videoAspectRatio: '16:9',
            videoResolution: '720p',
            videoDuration: '6',
            useMultipleVideoModels: false,
        })

        const payload = natsPublishMock.mock.calls.at(-1)?.[1] as Record<string, any>
        expect(payload.aiVideoModels).toEqual(['video-a'])
        expect(payload.mediaGenerationRequest).toMatchObject({
            useMultipleVideoModels: false,
            imageModelIds: ['image-a', 'image-b'],
            videoModelIds: [],
        })
        expect(payload.mediaGenerationRequest).not.toHaveProperty('videoOptions')
    })

    it('publishes stop event through NATS via a request/response call', async () => {
        await service.stopChatMessage()

        expect(natsRequestMock).toHaveBeenCalledWith(
            AI_INTERACTION_SUBJECTS.CHAT_STOP_MESSAGE,
            {
                token: 'auth-token',
                workspaceId,
                conversationAssetId,
            },
        )
    })

    it('disconnects from the thread response subject and clears runtime provider state', () => {
        const unsubscribeMock = natsSubscribeMock.mock.results[0].value.unsubscribe

        service.updateRunProvider(conversationAssetId, 'provider-x')
        service.shouldProcessPipelinePayload({
            pipelineEventId: 'event-to-forget',
            pipelineStreamSeq: 7,
        })
        service.disconnect()

        expect(unsubscribeMock).toHaveBeenCalled()
        expect(natsGetSubscriptionsMock).not.toHaveBeenCalled()
        expect(service.currentAiProvider).toBeNull()
        expect(service.providersByRunKey.size).toBe(0)
        expect(service.pipelineEventIds.size).toBe(0)
    })

    it('releases only its subscription when another view uses the same conversation', async () => {
        const first = natsSubscribeMock.mock.results[0].value
        const other = new AiInteractionService({
            auth,
            workspaceId,
            conversationAssetId,
            organizationId,
            userStore,
        })
        await flushPromises()
        const second = natsSubscribeMock.mock.results[1].value

        expect(first.unsubscribe).not.toHaveBeenCalled()
        service.disconnect()
        service.disconnect()
        expect(first.unsubscribe).toHaveBeenCalledTimes(1)
        expect(second.unsubscribe).not.toHaveBeenCalled()
        other.disconnect()
        expect(second.unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('ignores queued live callbacks and replay responses after disconnect', async () => {
        let resolveReplay!: (value: unknown) => void
        natsRequestMock.mockImplementationOnce(() =>
            new Promise(resolve => void (resolveReplay = resolve))
        )
        const replay = service.resumePipelineEventStream()
        await flushPromises()
        const callback = natsSubscribeMock.mock.calls[0][1]
        service.disconnect()
        callback({ error: 'queued live error' })
        resolveReplay({ events: [{
            payload: { error: 'late replay error' },
            streamSequence: 1,
        }] })
        await replay
        expect(onErrorMock).not.toHaveBeenCalled()
        expect(receiveSegmentMock).not.toHaveBeenCalled()
    })

    it('does not start replay after disconnect while authorization is pending', async () => {
        let authorize!: (token: string) => void
        getTokenSilentlyMock.mockImplementationOnce(() =>
            new Promise(resolve => void (authorize = resolve))
        )
        natsRequestMock.mockClear()
        const replay = service.resumePipelineEventStream()
        service.disconnect()
        authorize('token')
        await replay
        await service.resumePipelineEventStream()
        expect(natsRequestMock).not.toHaveBeenCalled()
    })

    it('rejects another workspace before forwarding a segment', () => {
        service.onChatMessageResponse({
            workspaceId: 'another-workspace',
            error: 'wrong workspace',
        })
        expect(onErrorMock).not.toHaveBeenCalled()
        expect(receiveSegmentMock).not.toHaveBeenCalled()
    })
})
