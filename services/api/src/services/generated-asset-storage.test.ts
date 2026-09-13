import {
    type Asset,
    type CanvasState,
    type MediaGenerationRunMeta,
} from '@lixpi/constants'
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// DynamoDB reports a failed per-item transaction condition as a cancelled transaction.
class TransactionCanceledError extends Error {
    readonly CancellationReasons = [{ Code: 'ConditionalCheckFailed' }]

    constructor(message: string) {
        super(message)
        this.name = 'TransactionCanceledException'
    }
}

const mocks = vi.hoisted(() => ({
    assertAssetComponents: vi.fn(),
    attachWorkspaceReference: vi.fn(),
    blobStore: vi.fn(),
    buildAssetCanvasGeometryUpdate: vi.fn(),
    buildBlobReferenceOperations: vi.fn(),
    buildBlobReferenceBatchOperations: vi.fn(),
    enqueueRenditionRetry: vi.fn(),
    getAssetRecord: vi.fn(),
    getWorkspace: vi.fn(),
    publishAssetEvent: vi.fn(),
    projectGeneratedAssetNode: vi.fn(),
    renditionProcess: vi.fn(),
    transactWrite: vi.fn(),
}))

vi.mock('../models/asset.ts', () => ({
    default: { attachWorkspaceReference: mocks.attachWorkspaceReference },
    assertAssetComponents: mocks.assertAssetComponents,
    buildAssetProjectionOperations: vi.fn(async () => []),
    getAssetRecord: mocks.getAssetRecord,
    publishAssetEvent: mocks.publishAssetEvent,
}))
vi.mock('../models/blob.ts', () => ({
    default: { store: mocks.blobStore },
    buildBlobReferenceBatchOperations: mocks.buildBlobReferenceBatchOperations,
    buildBlobReferenceOperations: mocks.buildBlobReferenceOperations,
}))
vi.mock('../models/workspace.ts', () => ({
    default: { getWorkspace: mocks.getWorkspace },
}))
vi.mock('./asset-canvas-projection.ts', () => ({
    buildAssetCanvasGeometryUpdate: mocks.buildAssetCanvasGeometryUpdate,
    projectGeneratedAssetNode: mocks.projectGeneratedAssetNode,
}))
vi.mock('./asset-rendition-service.ts', () => ({
    default: { process: mocks.renditionProcess },
}))
vi.mock('./asset-maintenance-queue.ts', () => ({
    enqueueRenditionRetry: mocks.enqueueRenditionRetry,
}))

import {
    attachGeneratedAssetNode,
    collectGeneratedAssetSourceIds,
    resolveInheritedGenerationSeed,
    settleGeneratedAssetOriginal,
    settleGeneratedAssetComposition,
} from './generated-asset-storage.ts'

const generationRun: MediaGenerationRunMeta = {
    requestKind: 'media-generation-matrix',
    generationRequestId: 'request-1',
    mediaRunId: 'media-1',
    mediaType: 'image',
    mediaIndex: 0,
    variantIndex: 0,
    lineageAssignment: {
        assetId: 'asset-1',
        generationRequestId: 'request-1',
        mediaRunId: 'media-1',
        mediaType: 'image',
        mediaIndex: 0,
        branchId: 'branch-1',
        lineageParentNodeId: 'fork-1',
        referenceAssetIds: [],
        referenceNodeIds: [],
        sourceContextNodeIds: [],
        promptText: 'draw a stone',
        createdAt: 1,
    },
}

const asset = (originalReady: boolean): Asset => ({
    assetId: 'asset-1',
    organizationId: 'organization-1',
    title: 'Generated image',
    scope: 'workspace',
    scopeOwnerId: 'workspace-1',
    originWorkspaceId: 'workspace-1',
    ownerUserId: 'user-1',
    documents: {},
    ...(originalReady
        ? {
            media: {
                kind: 'image',
                originalName: 'image.png',
                sourceMimeType: 'image/png',
                modelSafe: true,
                renditions: {
                    original: {
                        name: 'original',
                        status: 'ready',
                        blobHash: 'hash-1',
                        mimeType: 'image/png',
                        byteSize: 100,
                        updatedAt: 1,
                    },
                },
            },
        }
        : {}),
    states: {
        lifecycle: 'creating',
        media: 'processing',
        conversation: 'none',
        provenance: 'building',
    },
    referenceCount: 1,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
})

const canvasState: CanvasState = {
    viewport: {
        x: 0,
        y: 0,
        zoom: 1,
    },
    nodes: [],
    edges: [],
}

describe('collectGeneratedAssetSourceIds', () => {
    it('preserves Asset-only references while translating only node-backed context IDs', () => {
        expect(collectGeneratedAssetSourceIds(
            {
                ...generationRun.lineageAssignment!,
                referenceAssetIds: ['library-portrait', 'context-node'],
                sourceContextNodeIds: ['context-node'],
            },
            {
                resolverVersion: 'image-branch-vlm-v1',
                conversationAssetId: 'thread-1',
                regionNodeId: 'standalone:thread-1',
                promptText: 'Use both references',
                promptFingerprint: 'fingerprint',
                transcriptContext: '',
                candidates: [{
                    candidateId: 'node:context-node',
                    nodeId: 'context-node',
                    assetId: 'context-asset',
                    imageUrl: 'nats-obj://assets/context',
                    roleHints: ['base-context'],
                    ancestorNodeIds: ['context-node'],
                    sourceContextNodeIds: ['context-node'],
                }],
            },
        )).toEqual(['library-portrait', 'context-node', 'context-asset'])
    })
})

beforeEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
    ;(globalThis as any).dynamoDBService = { transactWrite: mocks.transactWrite }
    mocks.buildBlobReferenceBatchOperations.mockReturnValue({
        operations: [],
        deletionBlobHashes: [],
    })
    mocks.buildBlobReferenceOperations.mockReturnValue([])
    mocks.renditionProcess.mockResolvedValue(undefined)
    mocks.transactWrite.mockResolvedValue(undefined)
    mocks.getWorkspace.mockResolvedValue({
        workspaceId: 'workspace-1',
        updatedAt: 100,
        canvasStateUpdatedAt: 100,
        canvasState,
    })
    mocks.projectGeneratedAssetNode.mockReturnValue({
        canvasState,
        nodeId: 'pending-image-media-1',
        geometryNodes: [],
    })
    mocks.attachWorkspaceReference.mockResolvedValue({
        assetId: 'asset-1',
        referenceKey: 'workspace#workspace-1',
        type: 'workspace',
        nodeIds: ['pending-image-media-1'],
        createdAt: 1,
        updatedAt: 101,
    })
    mocks.buildAssetCanvasGeometryUpdate.mockImplementation((params) => ({
        generationRequestId: params.generationRequestId,
        layoutRevision: params.layoutRevision,
        nodes: params.geometryNodes,
    }))
})

// =============================================================================
// INHERITED GENERATION SEED
// =============================================================================

describe('resolveInheritedGenerationSeed', () => {
    const seededAsset = (assetId: string, lineage: Asset['lineage']): Asset => ({
        ...asset(true),
        assetId,
        ...(lineage ? { lineage } : {}),
    })

    beforeEach(() => void mocks.getAssetRecord.mockReset())

    it('reuses the parent Asset seed when a branch continues an earlier generation', async () => {
        mocks.getAssetRecord.mockImplementation(async (assetId: string) => ({
            'pending-asset': seededAsset('pending-asset', {
                parentAssetId: 'parent-asset',
                sourceAssetIds: ['reference-asset'],
            }),
            'parent-asset': seededAsset('parent-asset', {
                sourceAssetIds: [],
                generationSeed: 777,
            }),
            'reference-asset': seededAsset('reference-asset', {
                sourceAssetIds: [],
                generationSeed: 999,
            }),
        }[assetId]))

        expect(
            await resolveInheritedGenerationSeed({
                assetId: 'pending-asset',
                maxValue: 2147483647,
            }),
        ).toBe(777)
    })

    it('falls back to a referenced generated Asset when there is no parent', async () => {
        mocks.getAssetRecord.mockImplementation(async (assetId: string) => ({
            'pending-asset': seededAsset('pending-asset', { sourceAssetIds: ['uploaded-asset', 'reference-asset'] }),
            'uploaded-asset': seededAsset('uploaded-asset', { sourceAssetIds: [] }),
            'reference-asset': seededAsset('reference-asset', {
                sourceAssetIds: [],
                generationSeed: 999,
            }),
        }[assetId]))

        expect(
            await resolveInheritedGenerationSeed({
                assetId: 'pending-asset',
                maxValue: 2147483647,
            }),
        ).toBe(999)
    })

    it('skips a seed the target provider would reject and reports none', async () => {
        mocks.getAssetRecord.mockImplementation(async (assetId: string) => ({
            'pending-asset': seededAsset('pending-asset', { sourceAssetIds: ['reference-asset'] }),
            'reference-asset': seededAsset('reference-asset', {
                sourceAssetIds: [],
                generationSeed: 4294967000,
            }),
        }[assetId]))

        expect(
            await resolveInheritedGenerationSeed({
                assetId: 'pending-asset',
                maxValue: 2147483647,
            }),
        ).toBeUndefined()
    })

    it('reports none when nothing in the lineage carries a seed', async () => {
        mocks.getAssetRecord.mockImplementation(async (assetId: string) => ({
            'pending-asset': seededAsset('pending-asset', { sourceAssetIds: ['reference-asset'] }),
            'reference-asset': seededAsset('reference-asset', { sourceAssetIds: [] }),
        }[assetId]))

        expect(
            await resolveInheritedGenerationSeed({
                assetId: 'pending-asset',
                maxValue: 2147483647,
            }),
        ).toBeUndefined()
    })
})

describe('settleGeneratedAssetOriginal', () => {
    it('marks MOV as non-model-safe and stores the returned last frame as the representative frame', async () => {
        mocks.getAssetRecord.mockResolvedValue(asset(false))
        mocks.blobStore
            .mockResolvedValueOnce({
                blobKey: 'organization-1:video-hash',
                blobHash: 'a'.repeat(64),
                organizationId: 'organization-1',
                referenceCount: 0,
                status: 'staging',
            })
            .mockResolvedValueOnce({
                blobKey: 'organization-1:frame-hash',
                blobHash: 'b'.repeat(64),
                organizationId: 'organization-1',
                referenceCount: 0,
                status: 'staging',
            })

        await settleGeneratedAssetOriginal({
            generationRun,
            workspaceId: 'workspace-1',
            buffer: Buffer.from('mov-bytes'),
            originalName: 'generated-video.mov',
            mimeType: 'video/quicktime',
            kind: 'video',
            representativeFrameBuffer: Buffer.from('png-bytes'),
        })

        const transaction = mocks.transactWrite.mock.calls[0]?.[0]
        const assetUpdate = transaction.operations.find((operation: any) => operation.updates?.media)
        expect(assetUpdate.updates.media).toMatchObject({
            kind: 'video',
            originalName: 'generated-video.mov',
            sourceMimeType: 'video/quicktime',
            modelSafe: false,
            renditions: {
                original: {
                    mimeType: 'video/quicktime',
                    status: 'ready',
                },
                representativeFrame: {
                    mimeType: 'image/png',
                    status: 'ready',
                },
            },
        })
        expect(mocks.buildBlobReferenceOperations).toHaveBeenCalledWith(expect.objectContaining({
            reference: expect.objectContaining({
                referenceKey: 'asset#asset-1#rendition#representativeFrame',
            }),
        }))
    })
})

describe('settleGeneratedAssetComposition', () => {
    it('stores isolated panel blobs and atomically attaches their references to the pending Asset', async () => {
        const pending = asset(false)
        mocks.getAssetRecord.mockResolvedValue(pending)
        mocks.blobStore
            .mockResolvedValueOnce({
                blobKey: 'organization-1:head-hash',
                blobHash: 'a'.repeat(64),
                organizationId: 'organization-1',
                referenceCount: 0,
                status: 'staging',
            })
            .mockResolvedValueOnce({
                blobKey: 'organization-1:body-hash',
                blobHash: 'b'.repeat(64),
                organizationId: 'organization-1',
                referenceCount: 0,
                status: 'staging',
            })

        const composition = await settleGeneratedAssetComposition({
            generationRun,
            composition: {
                kind: 'character-sheet',
                capabilityId: 'global.character-creator',
                sourceAssetIds: ['source-1'],
                components: [
                    {
                        componentId: 'head-front-neutral',
                        role: 'character-sheet-panel',
                        title: 'Neutral front identity portrait',
                        imageBase64: Buffer.from('head').toString('base64'),
                        mimeType: 'image/png',
                    },
                    {
                        componentId: 'body-front',
                        role: 'character-sheet-panel',
                        title: 'Front body',
                        imageBase64: Buffer.from('body').toString('base64'),
                        mimeType: 'image/png',
                    },
                ],
            },
        })

        expect(mocks.blobStore).toHaveBeenCalledTimes(2)
        expect(mocks.buildBlobReferenceBatchOperations).toHaveBeenCalledWith(expect.objectContaining({
            additions: [
                expect.objectContaining({
                    reference: expect.objectContaining({
                        referenceKey: 'asset#asset-1#composition#head-front-neutral',
                    }),
                }),
                expect.objectContaining({
                    reference: expect.objectContaining({
                        referenceKey: 'asset#asset-1#composition#body-front',
                    }),
                }),
            ],
        }))
        expect(mocks.transactWrite).toHaveBeenCalledWith(expect.objectContaining({
            origin: 'settleGeneratedAssetComposition',
            operations: [expect.objectContaining({
                updates: expect.objectContaining({ composition }),
            })],
        }))
        expect(mocks.publishAssetEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ composition }))
    })
})

describe('attachGeneratedAssetNode', () => {
    it.each([
        {
            originalReady: false,
            expectedPending: true,
        },
        {
            originalReady: true,
            expectedPending: false,
        },
    ])('projects the API phase from Asset readiness before attaching', async ({
        originalReady,
        expectedPending,
    }) => {
        vi.useFakeTimers()
        vi.setSystemTime(100)
        mocks.getAssetRecord.mockResolvedValue(asset(originalReady))

        const geometry = await attachGeneratedAssetNode({
            assetId: 'asset-1',
            workspaceId: 'workspace-1',
            kind: 'image',
            aspectRatio: 16 / 9,
            generationRun,
            conversationAssetId: 'thread-1',
        })

        expect(mocks.projectGeneratedAssetNode).toHaveBeenCalledWith(expect.objectContaining({
            pendingBeforeFirstFrame: expectedPending,
        }))
        expect(mocks.attachWorkspaceReference).toHaveBeenCalledWith(expect.objectContaining({
            workspaceMutation: expect.objectContaining({
                expectedCanvasStateUpdatedAt: 100,
                canvasStateUpdatedAt: 101,
            }),
        }))
        expect(geometry.layoutRevision).toBe(101)
    })

    it('re-reads and reprojects after a concurrent attachment wins the workspace condition', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100)
        const conditionalFailure = new TransactionCanceledError('stale')
        mocks.getAssetRecord.mockResolvedValue(asset(false))
        mocks.getWorkspace
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 100,
                canvasStateUpdatedAt: 100,
                canvasState,
            })
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 101,
                canvasStateUpdatedAt: 101,
                canvasState,
            })
        mocks.attachWorkspaceReference
            .mockRejectedValueOnce(conditionalFailure)
            .mockResolvedValueOnce({
                assetId: 'asset-1',
                referenceKey: 'workspace#workspace-1',
                type: 'workspace',
                nodeIds: ['pending-image-media-1'],
                createdAt: 1,
                updatedAt: 102,
            })

        const geometry = await attachGeneratedAssetNode({
            assetId: 'asset-1',
            workspaceId: 'workspace-1',
            kind: 'image',
            aspectRatio: 1,
            generationRun,
            conversationAssetId: 'thread-1',
        })

        expect(mocks.getWorkspace).toHaveBeenCalledTimes(2)
        expect(mocks.projectGeneratedAssetNode).toHaveBeenCalledTimes(2)
        expect(mocks.attachWorkspaceReference).toHaveBeenCalledTimes(2)
        expect(geometry.layoutRevision).toBe(102)
    })

    it('re-reads and reprojects when the workspace mutation rejects a stale pre-transaction snapshot', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100)
        mocks.getAssetRecord.mockResolvedValue(asset(false))
        mocks.getWorkspace
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 100,
                canvasStateUpdatedAt: 100,
                canvasState,
            })
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 101,
                canvasStateUpdatedAt: 101,
                canvasState,
            })
        mocks.attachWorkspaceReference
            .mockRejectedValueOnce(new Error('STALE_CANVAS_STATE'))
            .mockResolvedValueOnce({
                assetId: 'asset-1',
                referenceKey: 'workspace#workspace-1',
                type: 'workspace',
                nodeIds: ['pending-image-media-1'],
                createdAt: 1,
                updatedAt: 102,
            })

        const geometry = await attachGeneratedAssetNode({
            assetId: 'asset-1',
            workspaceId: 'workspace-1',
            kind: 'image',
            aspectRatio: 1,
            generationRun,
            conversationAssetId: 'thread-1',
        })

        expect(mocks.getWorkspace).toHaveBeenCalledTimes(2)
        expect(mocks.projectGeneratedAssetNode).toHaveBeenCalledTimes(2)
        expect(mocks.attachWorkspaceReference).toHaveBeenCalledTimes(2)
        expect(geometry.layoutRevision).toBe(102)
    })

    it('bounds repeated stale pre-transaction snapshots to five attachment attempts', async () => {
        mocks.getAssetRecord.mockResolvedValue(asset(false))
        mocks.attachWorkspaceReference.mockRejectedValue(new Error('STALE_CANVAS_STATE'))

        await expect(attachGeneratedAssetNode({
            assetId: 'asset-1',
            workspaceId: 'workspace-1',
            kind: 'image',
            aspectRatio: 1,
            generationRun,
            conversationAssetId: 'thread-1',
        })).rejects.toThrow('STALE_CANVAS_STATE')

        expect(mocks.getWorkspace).toHaveBeenCalledTimes(5)
        expect(mocks.projectGeneratedAssetNode).toHaveBeenCalledTimes(5)
        expect(mocks.attachWorkspaceReference).toHaveBeenCalledTimes(5)
    })

    it('does not retry an unrelated workspace attachment error', async () => {
        mocks.getAssetRecord.mockResolvedValue(asset(false))
        mocks.attachWorkspaceReference.mockRejectedValueOnce(new Error('WORKSPACE_ACCESS_DENIED'))

        await expect(attachGeneratedAssetNode({
            assetId: 'asset-1',
            workspaceId: 'workspace-1',
            kind: 'image',
            aspectRatio: 1,
            generationRun,
            conversationAssetId: 'thread-1',
        })).rejects.toThrow('WORKSPACE_ACCESS_DENIED')

        expect(mocks.getWorkspace).toHaveBeenCalledTimes(1)
        expect(mocks.projectGeneratedAssetNode).toHaveBeenCalledTimes(1)
        expect(mocks.attachWorkspaceReference).toHaveBeenCalledTimes(1)
    })

    it('uses the wall clock for a legacy workspace with no persisted canvas revision', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100)
        mocks.getAssetRecord.mockResolvedValue(asset(false))
        mocks.getWorkspace.mockResolvedValueOnce({
            workspaceId: 'workspace-1',
            canvasState,
        })

        const geometry = await attachGeneratedAssetNode({
            assetId: 'asset-1',
            workspaceId: 'workspace-1',
            kind: 'image',
            aspectRatio: 1,
            generationRun,
            conversationAssetId: 'thread-1',
        })

        expect(mocks.attachWorkspaceReference).toHaveBeenCalledWith(expect.objectContaining({
            workspaceMutation: expect.objectContaining({ canvasStateUpdatedAt: 100 }),
        }))
        expect(geometry.layoutRevision).toBe(100)
    })
})
