import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    getAssetEventSubject,
    NATS_SUBJECTS,
    type Asset,
} from '@lixpi/constants'

import AssetService from './asset-service.ts'

const mocks = vi.hoisted(() => ({
    getTokenSilently: vi.fn(),
    request: vi.fn(),
    getWorkspace: vi.fn(),
    getAsset: vi.fn(),
    setLoading: vi.fn(),
    setAssets: vi.fn(),
    setError: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
}))

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: {
        getData: vi.fn(() => ({
            request: mocks.request,
            subscribe: mocks.subscribe,
        })),
    },
}))

vi.mock('$src/stores/assetsStore.ts', () => ({
    assetsStore: {
        get: mocks.getAsset,
        setLoading: mocks.setLoading,
        setAssets: mocks.setAssets,
        setError: mocks.setError,
        upsert: mocks.upsert,
        remove: mocks.remove,
    },
}))

vi.mock('$src/stores/assetDocumentsStore.ts', () => ({
    assetDocumentsStore: {
        get: vi.fn(() => undefined),
        set: vi.fn(),
        setMany: vi.fn(),
    },
}))

vi.mock('$src/stores/workspaceStore.ts', () => ({
    workspaceStore: {
        getData: mocks.getWorkspace,
    },
}))

const createAssetService = (): AssetService => new AssetService({
    auth: { getTokenSilently: mocks.getTokenSilently },
    userStore: { getData: () => 'user-1' } as never,
})

const makeAsset = (overrides: Partial<Asset> & Pick<Asset, 'assetId' | 'title'>): Asset => {
    return {
        organizationId: 'organization-1',
        scope: 'workspace',
        scopeOwnerId: 'workspace-1',
        originWorkspaceId: 'workspace-1',
        ownerUserId: 'user-1',
        documents: {},
        states: {
            lifecycle: 'active',
            media: 'ready',
            conversation: 'none',
            provenance: 'none',
        },
        referenceCount: 1,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    }
}

describe('AssetService.startWorkspaceSynchronization', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.subscribe.mockReturnValue({ unsubscribe: mocks.unsubscribe })
        mocks.getAsset.mockReturnValue(undefined)
    })

    it('does not reload the workspace catalog for events about unloaded Assets', () => {
        vi.useFakeTimers()
        const service = createAssetService()
        const loadWorkspaceAssets = vi.spyOn(service, 'loadWorkspaceAssets').mockResolvedValue([])
        const stop = service.startWorkspaceSynchronization('workspace-1')
        const updatedSubject = getAssetEventSubject(
            'user-1',
            NATS_SUBJECTS.ASSET_SUBJECTS.EVENTS.UPDATED,
        )
        const updatedSubscription = mocks.subscribe.mock.calls.find(
            ([subject]) => subject === updatedSubject,
        )
        const onUpdated = updatedSubscription?.[1] as ((data: { assetId: string }) => void) | undefined

        expect(onUpdated).toBeTypeOf('function')
        onUpdated?.({ assetId: 'unloaded-asset' })
        expect(loadWorkspaceAssets).not.toHaveBeenCalled()

        stop()
        vi.useRealTimers()
    })
})

describe('AssetService.create', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getTokenSilently.mockResolvedValue('token')
    })

    it('rejects API errors without inserting the error reply into the Asset store', async () => {
        mocks.request.mockResolvedValue({ error: 'INITIAL_EMBEDDED_ASSETS_REQUIRE_ATTACH' })
        const service = createAssetService()

        await expect(service.create({
            organizationId: 'organization-1',
            workspaceId: 'workspace-1',
            title: 'Referenced Action Timeline request',
            primaryCategory: 'conversation',
            assetId: 'conversation-1',
            initialDoc: {
                type: 'doc',
                content: [],
            },
        })).rejects.toThrow('Asset creation failed: INITIAL_EMBEDDED_ASSETS_REQUIRE_ATTACH')

        expect(mocks.request).toHaveBeenCalledWith(
            NATS_SUBJECTS.ASSET_SUBJECTS.CREATE,
            expect.objectContaining({
                token: 'token',
                assetId: 'conversation-1',
                primaryCategory: 'conversation',
            }),
            undefined,
        )
        expect(mocks.upsert).not.toHaveBeenCalled()
    })
})

describe('AssetService.loadWorkspaceAssets', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getTokenSilently.mockResolvedValue('token')
        mocks.getAsset.mockReturnValue(undefined)
        mocks.getWorkspace.mockImplementation((key?: string) =>
            key === 'workspaceId' ? 'workspace-1' : ({
                workspaceId: 'workspace-1',
                canvasState: {
                    nodes: [{
                        nodeId: 'timeline-node',
                        type: 'capabilityArtifact',
                        assetId: 'timeline-asset',
                        artifactTypeId: 'action-timeline',
                        position: {
                            x: 0,
                            y: 0,
                        },
                        dimensions: {
                            width: 400,
                            height: 300,
                        },
                    }],
                },
            })
        )
    })

    it('loads lineage source Assets required by persisted Artifact references', async () => {
        const timelineAsset = makeAsset({
            assetId: 'timeline-asset',
            title: 'Action Timeline',
            artifact: {
                artifactTypeId: 'action-timeline',
                schemaVersion: 'action-timeline-v1',
            },
            lineage: { sourceAssetIds: ['shelby-asset', 'train-asset'] },
            states: {
                lifecycle: 'active',
                media: 'none',
                conversation: 'none',
                provenance: 'sealed',
            },
        })
        const shelbyAsset = makeAsset({
            assetId: 'shelby-asset',
            title: 'Shelby',
            media: {
                kind: 'image',
                originalName: 'shelby.png',
                sourceMimeType: 'image/png',
                modelSafe: true,
                renditions: {},
            },
        })
        const trainAsset = makeAsset({
            assetId: 'train-asset',
            title: 'Slop Train',
            media: {
                kind: 'image',
                originalName: 'train.png',
                sourceMimeType: 'image/png',
                modelSafe: true,
                renditions: {},
            },
        })
        mocks.request.mockImplementation(async (_subject: string, payload: Record<string, unknown>) => {
            if (payload.assetId === 'timeline-asset')
                return timelineAsset

            if (payload.assetId === 'shelby-asset')
                return shelbyAsset

            if (payload.assetId === 'train-asset')
                return trainAsset

            return { error: 'NOT_FOUND' }
        })

        const service = createAssetService()
        const assets = await service.loadWorkspaceAssets('workspace-1')

        expect(assets.map(asset => [asset.assetId, asset.title])).toEqual([
            ['timeline-asset', 'Action Timeline'],
            ['shelby-asset', 'Shelby'],
            ['train-asset', 'Slop Train'],
        ])
        expect(mocks.setAssets).toHaveBeenCalledWith('workspace-1', assets)
        expect(mocks.request).toHaveBeenCalledTimes(3)
        expect(mocks.request).not.toHaveBeenCalledWith(
            NATS_SUBJECTS.ASSET_SUBJECTS.LIST,
            expect.anything(),
            expect.anything(),
        )
    })
})

describe('AssetService.ensureAssetsLoaded', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getTokenSilently.mockResolvedValue('token')
    })

    it('hydrates missing Artifact reference Assets without reloading cached Assets', async () => {
        const cachedAsset = makeAsset({
            assetId: 'cached-asset',
            title: 'Shelby',
        })
        const missingAsset = makeAsset({
            assetId: 'missing-asset',
            title: 'Slop Train',
        })
        mocks.getAsset.mockImplementation((assetId: string) => (
            assetId === cachedAsset.assetId ? cachedAsset : undefined
        ))
        mocks.request.mockResolvedValue(missingAsset)

        const service = createAssetService()
        const loaded = await service.ensureAssetsLoaded([
            cachedAsset.assetId,
            missingAsset.assetId,
            missingAsset.assetId,
        ])

        expect(loaded).toEqual([missingAsset])
        expect(mocks.request).toHaveBeenCalledTimes(1)
        expect(mocks.request).toHaveBeenCalledWith(
            NATS_SUBJECTS.ASSET_SUBJECTS.GET,
            {
                token: 'token',
                assetId: missingAsset.assetId,
            },
            undefined,
        )
        expect(mocks.upsert).toHaveBeenCalledWith(missingAsset)
    })
})
