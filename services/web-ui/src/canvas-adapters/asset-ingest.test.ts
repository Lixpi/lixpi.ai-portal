import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    uploadCanvasAsset,
    importCanvasAssetUrl,
} from './asset-ingest.ts'

const token = vi.hoisted(() => vi.fn())
const auth = { getTokenSilently: token }
const request = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    token.mockResolvedValue('token')
    request.mockResolvedValue({
        ok: true,
        json: async () => ({
            assetId: 'asset',
            kind: 'image',
        }),
    })
    vi.stubGlobal('fetch', request)
    vi.stubEnv('VITE_API_URL', 'https://api.example.test')
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

describe('canvas Asset ingest transport', () => {
    it('uploads file bytes after authorization and admission without exposing the token to the package', async () => {
        const file = new File(['pixels'], 'image.png', { type: 'image/png' })
        const onStart = vi.fn(() => true)
        expect(await uploadCanvasAsset(auth, {
            workspaceId: 'workspace',
            file,
            onStart,
        })).toEqual({
            assetId: 'asset',
            kind: 'image',
        })
        const [url, options] = request.mock.calls[0]
        expect(url).toBe('https://api.example.test/api/assets/workspaces/workspace')
        expect(options.headers).toEqual({ Authorization: 'Bearer token' })
        expect(options.body.get('file').name).toBe('image.png')
        expect(onStart).toHaveBeenCalledOnce()
    })

    it('sends URL import requests through the existing endpoint', async () => {
        await importCanvasAssetUrl(auth, {
            workspaceId: 'workspace',
            url: 'https://source.test/image',
            onStart: () => true,
        })
        expect(request).toHaveBeenCalledWith('https://api.example.test/api/assets/workspaces/workspace/import-url', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer token',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: 'https://source.test/image' }),
        })
    })

    it('does not send after authorization fails or the canvas declines admission', async () => {
        const onStart = vi.fn(() => false)
        expect(await importCanvasAssetUrl(auth, {
            workspaceId: 'workspace',
            url: 'url',
            onStart,
        })).toBeNull()
        token.mockResolvedValue(false)
        onStart.mockClear()
        expect(await importCanvasAssetUrl(auth, {
            workspaceId: 'workspace',
            url: 'url',
            onStart,
        })).toBeNull()
        expect(onStart).not.toHaveBeenCalled()
        expect(request).not.toHaveBeenCalled()
    })

    it('preserves API error messages and rejects malformed successful replies', async () => {
        request.mockResolvedValueOnce({
            ok: false,
            json: async () => ({ error: 'Unsupported file' }),
        })
        const args = {
            workspaceId: 'workspace',
            url: 'url',
            onStart: () => true,
        }
        expect(await importCanvasAssetUrl(auth, args)).toEqual({ error: 'Unsupported file' })
        request.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                assetId: 'asset',
                kind: 'unknown',
            }),
        })
        await expect(importCanvasAssetUrl(auth, args)).rejects.toThrow('INVALID_ASSET_INGEST_REPLY')
    })
})
