import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { createContextPreviewEnvironment } from './context-preview-environment.ts'

const getTokenSilently = vi.fn(async () => 'a/b ?c')
const auth = { getTokenSilently }
afterEach(() => vi.clearAllMocks())

const fixture = () => {
    return createContextPreviewEnvironment(auth, {
        document,
        getDocuments: () => [],
        getThreads: () => [],
    })
}

describe('context preview infrastructure adapter', () => {
    it('encodes Asset identity, rendition and the current token through the shared URL utility', async () => {
        const port = fixture()
        const source = await port.resolveRenditionUrl('asset/id', 'original', new AbortController().signal)
        const url = new URL(source, 'https://app.test')
        expect(url.pathname).toBe('/api/assets/asset%2Fid/renditions/original')
        expect(url.searchParams.get('token')).toBe('a/b ?c')
        expect(port.initialRenditionUrl('asset/id', 'preview')).toBe('/api/assets/asset%2Fid/renditions/preview')
    })

    it('does not request credentials for an already disposed preview', async () => {
        const lifetime = new AbortController()
        lifetime.abort()
        expect(await fixture().resolveRenditionUrl('a', 'preview', lifetime.signal)).toBe('')
        expect(getTokenSilently).not.toHaveBeenCalled()
    })

    it('uses application document extraction and preserves paragraph separation and malformed-input handling', () => {
        const port = fixture()
        expect(port.extractDocumentText({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{
                        type: 'text',
                        text: 'First',
                    }],
                },
                {
                    type: 'paragraph',
                    content: [{
                        type: 'text',
                        text: 'Second',
                    }],
                },
            ],
        })).toBe('First\nSecond')
        expect(port.extractDocumentText('')).toBe('')
    })
})
