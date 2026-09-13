import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

const mocks = vi.hoisted(() => {
    const getRoutes: Array<{
        path: string
        handlers: Array<(req: any, res: any, next?: () => void) => unknown>
    }> = []
    const router = {
        get: vi.fn((path: string, ...handlers: Array<(req: any, res: any, next?: () => void) => unknown>) => void getRoutes.push({
            path,
            handlers,
        })),
        post: vi.fn(),
    }

    return {
        getRoutes,
        router,
        verifyJwt: vi.fn(),
        getRequesterContext: vi.fn(),
        getAsset: vi.fn(),
        loadSnapshot: vi.fn(),
    }
})

vi.mock('express', () => ({ Router: vi.fn(() => mocks.router) }))
// Multer's default export is a callable factory that also carries storage builders.
vi.mock('multer', () => {
    const multer: ReturnType<typeof vi.fn> & { memoryStorage?: ReturnType<typeof vi.fn> } = vi.fn(() => ({ single: vi.fn(() => 'upload-middleware') }))
    multer.memoryStorage = vi.fn(() => 'memory-storage')

    return { default: multer }
})
vi.mock('@lixpi/nats-service', () => ({ default: { getInstance: vi.fn() } }))
vi.mock('../helpers/auth.ts', () => ({ jwtVerifier: { verify: mocks.verifyJwt } }))
vi.mock('../models/asset.ts', () => ({ default: { get: mocks.getAsset } }))
vi.mock('../models/blob.ts', () => ({ default: { get: vi.fn() } }))
vi.mock('../models/workspace.ts', () => ({ default: { getWorkspace: vi.fn() } }))
vi.mock('../services/asset-requester-context.ts', () => ({
    getAssetRequesterContext: mocks.getRequesterContext,
}))
vi.mock('../services/asset-document-service.ts', () => ({
    default: { loadSnapshot: mocks.loadSnapshot },
}))
vi.mock('../services/asset-ingest.ts', () => ({
    AssetFileRejectedError: class AssetFileRejectedError extends Error {},
    ingestAssetFile: vi.fn(),
}))
vi.mock('../services/public-remote-file.ts', () => ({ fetchPublicRemoteFile: vi.fn() }))

await import('./asset-routes.ts')

const getSnapshotHandler = (): (req: any, res: any) => Promise<unknown> => {
    const route = mocks.getRoutes.find(candidate => candidate.path === '/:assetId/documents/:role/snapshot')
    const handler = route?.handlers.at(-1)

    if (!handler)
        throw new Error('Snapshot route was not registered')

    return handler as (req: any, res: any) => Promise<unknown>
}

const createResponse = () => {
    const response = {
        status: vi.fn(),
        json: vi.fn(),
        setHeader: vi.fn(),
        end: vi.fn(),
    }
    response.status.mockReturnValue(response)
    response.json.mockReturnValue(response)
    response.end.mockReturnValue(response)

    return response
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRequesterContext.mockResolvedValue({ userId: 'user-1' })
})

describe('Asset document snapshot route', () => {
    it('serves the capabilityArtifact document role', async () => {
        const asset = {
            assetId: 'artifact-1',
            organizationId: 'organization-1',
        }
        const snapshot = {
            organizationId: 'organization-1',
            assetId: 'artifact-1',
            role: 'capabilityArtifact',
            blobHash: 'a'.repeat(64),
            version: 0,
            schemaVersion: 'action-timeline-v1',
            doc: {
                type: 'doc',
                content: [],
            },
        }
        mocks.getAsset.mockResolvedValue(asset)
        mocks.loadSnapshot.mockResolvedValue(snapshot)
        const response = createResponse()

        await getSnapshotHandler()({
            params: {
                assetId: 'artifact-1',
                role: 'capabilityArtifact',
            },
            headers: {},
            user: { userId: 'user-1' },
        }, response)

        expect(mocks.loadSnapshot).toHaveBeenCalledWith(asset, 'capabilityArtifact')
        expect(response.status).not.toHaveBeenCalledWith(400)
        expect(response.json).toHaveBeenCalledWith(snapshot)
    })

    it('still rejects unknown document roles before loading an Asset', async () => {
        const response = createResponse()

        await getSnapshotHandler()({
            params: {
                assetId: 'artifact-1',
                role: 'unknown',
            },
            headers: {},
            user: { userId: 'user-1' },
        }, response)

        expect(response.status).toHaveBeenCalledWith(400)
        expect(response.json).toHaveBeenCalledWith({ error: 'INVALID_DOCUMENT_ROLE' })
        expect(mocks.getAsset).not.toHaveBeenCalled()
    })
})
