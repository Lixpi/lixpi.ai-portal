import {
    describe,
    it,
    expect,
    beforeEach,
    vi,
} from 'vitest'
import { EditorState } from 'prosemirror-state'
import { testSchema } from '$src/components/proseMirror/plugins/testUtils/testSchema.ts'
import {
    aiGeneratedVideoNodeSpec,
    aiGeneratedVideoNodeView,
} from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiGeneratedVideoNode.ts'

vi.mock('@lixpi/ui-kit/components/video-controls', () => ({
    createVideoControls: vi.fn(() => ({
        render: vi.fn(),
        resize: vi.fn(),
        destroy: vi.fn(),
    })),
    applyVideoControlsHostStyleProperties: vi.fn(),
}))

import { createVideoControls } from '@lixpi/ui-kit/components/video-controls'

const getTokenSilently = vi.fn()
const auth = { getTokenSilently }

const createVideoNode = (attrs: Record<string, unknown> = {}) => {
    return testSchema.nodes.aiGeneratedVideo.create({
        videoUrl: '',
        assetId: 'video-asset-id',
        posterUrl: '',
        durationSeconds: 12,
        aspectRatio: 1.777,
        hasAudio: true,
        revisedPrompt: '',
        responseId: 'response-id',
        videoModel: '',
        isPending: true,
        errorMessage: '',
        generationRequestId: '',
        reasoningRunId: '',
        mediaRunId: '',
        reasoningModelId: '',
        mediaModelId: '',
        mediaType: 'video',
        variantIndex: null,
        width: '',
        alignment: 'left',
        textWrap: 'none',
        ...attrs,
    })
}

const createNodeView = (attrs: Record<string, unknown> = {}) => {
    const node = createVideoNode(attrs)
    const doc = testSchema.nodes.doc.create(null, [node])
    const state = EditorState.create({
        doc,
        schema: testSchema,
    })
    const view = {
        state,
        dispatch: vi.fn(),
        focus: vi.fn(),
    }

    return aiGeneratedVideoNodeView(node, view as any, () => 0, auth)
}

beforeEach(() => void getTokenSilently.mockReset().mockResolvedValue('token-1'))

describe('aiGeneratedVideoNodeSpec', () => {
    it('serializes core video attrs for ProseMirror DOM output', () => {
        const node = createVideoNode({
            videoUrl: '/video.mp4',
            assetId: 'file-1',
            responseId: 'resp-1',
            videoModel: 'Google:veo-3',
            generationRequestId: 'req-1',
            reasoningRunId: 'run-1',
            mediaRunId: 'media-1',
            reasoningModelId: 'reasoning-model',
            mediaModelId: 'media-model',
            variantIndex: 2,
        })
        const domSpec = aiGeneratedVideoNodeSpec.toDOM(node) as any[]

        expect(domSpec[0]).toBe('div')
        expect(domSpec[1].class).toBe('ai-generated-video')
        expect(domSpec[1]['data-video-url']).toBe('/video.mp4')
        expect(domSpec[1]['data-asset-id']).toBe('file-1')
        expect(domSpec[1]['data-response-id']).toBe('resp-1')
        expect(domSpec[1]['data-variant-index']).toBe('2')
    })

    it('parses data attrs and normalizes variant index numbers', () => {
        const el = document.createElement('div')
        el.className = 'ai-generated-video'
        el.setAttribute('data-video-url', 'https://cdn.local/example.mp4')
        el.setAttribute('data-video-model', 'Google:veo-3')
        el.setAttribute('data-is-pending', 'true')
        el.setAttribute('data-variant-index', '4')

        const parseRule = aiGeneratedVideoNodeSpec.parseDOM![0]
        const attrs = parseRule.getAttrs!(el as unknown as HTMLElement) as Record<string, any>

        expect(attrs.videoUrl).toBe('https://cdn.local/example.mp4')
        expect(attrs.videoModel).toBe('Google:veo-3')
        expect(attrs.isPending).toBe(true)
        expect(attrs.variantIndex).toBe(4)
    })

    it('returns null variantIndex for invalid values', () => {
        const el = document.createElement('div')
        el.className = 'ai-generated-video'
        el.setAttribute('data-variant-index', 'invalid')

        const parseRule = aiGeneratedVideoNodeSpec.parseDOM![0]
        const attrs = parseRule.getAttrs!(el as unknown as HTMLElement) as Record<string, any>

        expect(attrs.variantIndex).toBeNull()
    })
})

describe('aiGeneratedVideoNodeView', () => {
    let controlInstance: {
        resize: any
        destroy: any
    }

    beforeEach(() => {
        const mockedControls = createVideoControls as any
        vi.mocked(mockedControls).mockClear()
        controlInstance = {
            resize: vi.fn(),
            destroy: vi.fn(),
        }
        vi.mocked(mockedControls).mockReturnValue(controlInstance as any)
    })

    it('renders pending placeholder for incomplete runs', () => {
        const view = createNodeView({
            isPending: true,
            videoUrl: '',
            errorMessage: '',
        })
        const placeholder = view.dom.querySelector('.ai-generated-video-placeholder') as HTMLElement
        const video = view.dom.querySelector('.ai-generated-video-content') as HTMLVideoElement
        const errorPlaceholder = view.dom.querySelector('.video-error-placeholder')

        expect(placeholder.classList.contains('is-active')).toBe(true)
        expect(video.style.display).toBe('none')
        expect(errorPlaceholder).toBeNull()
    })

    it('switches to ready state when payload resolves', async () => {
        const view = createNodeView({
            isPending: true,
            videoUrl: '',
            errorMessage: '',
        })

        const readyNode = createVideoNode({
            isPending: false,
            errorMessage: '',
            videoUrl: 'data:video/mp4;base64,AAAA',
            posterUrl: 'data:image/png;base64,BBBB',
            mediaModelId: 'Google:veo-3.0-generate-001',
            variantIndex: 1,
        })

        expect(view.update(readyNode)).toBe(true)
        await Promise.resolve()

        const placeholder = view.dom.querySelector('.ai-generated-video-placeholder') as HTMLElement
        const video = view.dom.querySelector('.ai-generated-video-content') as HTMLVideoElement
        const meta = view.dom.querySelector('.ai-generated-media-run-meta') as HTMLElement

        expect(view.dom.className).toContain('ai-generated-video-wrapper')
        expect(placeholder.classList.contains('is-active')).toBe(false)
        expect(video.style.display).toBe('block')
        expect(meta.textContent).toContain('veo-3.0-generate-001')
        expect(meta.textContent).toContain('Google')
    })

    it('renders inline error UI on hard failure states', async () => {
        const view = createNodeView({
            isPending: false,
            videoUrl: 'data:video/mp4;base64,AAAA',
            errorMessage: 'Video unavailable right now',
        })

        await Promise.resolve()
        const errorPlaceholder = view.dom.querySelector('.video-error-placeholder') as HTMLElement

        expect(errorPlaceholder).toBeDefined()
        expect(errorPlaceholder.textContent).toContain('Video unavailable right now')
    })

    it('stops events for controls and media content', () => {
        const view = createNodeView({
            isPending: true,
            videoUrl: '',
            errorMessage: '',
        })

        const controlsHost = view.dom.querySelector('.ai-generated-video-controls-host') as HTMLElement
        const video = view.dom.querySelector('.ai-generated-video-content') as HTMLElement
        const container = view.dom.querySelector('.ai-generated-video-container') as HTMLElement

        expect(view.stopEvent!({ target: controlsHost } as Event)).toBe(true)
        expect(view.stopEvent!({ target: video } as Event)).toBe(true)
        expect(view.stopEvent!({ target: container } as Event)).toBe(false)
    })

    it('creates controls when ready and destroys them on cleanup', async () => {
        const view = createNodeView({
            isPending: false,
            videoUrl: 'data:video/mp4;base64,AAAA',
            errorMessage: '',
        })
        await vi.waitFor(() => expect(vi.mocked(createVideoControls)).toHaveBeenCalled())

        view.destroy()

        expect(controlInstance.destroy).toHaveBeenCalled()
    })

    it('refreshes /api/files URLs and tokens for full URLs', async () => {
        const view = createNodeView({
            isPending: false,
            videoUrl: 'https://cdn.example.com/api/files/workspace-id/video.mp4?token=stale',
            posterUrl: 'https://cdn.example.com/api/files/workspace-id/poster.png?token=stale',
            errorMessage: '',
        })

        const video = view.dom.querySelector('.ai-generated-video-content') as HTMLVideoElement

        await vi.waitFor(() => {
            const resolvedVideoSrc = video.getAttribute('src') || video.src
            expect(resolvedVideoSrc).toContain('token=token-1')
            expect(resolvedVideoSrc).not.toContain('token=stale')
        })

        const resolvedPosterSrc = video.poster || video.getAttribute('poster')
        expect(resolvedPosterSrc).toContain('token=token-1')
        expect(resolvedPosterSrc).not.toContain('token=stale')
    })

    it('refreshes API urls but preserves non-API poster URLs', async () => {
        const view = createNodeView({
            isPending: false,
            videoUrl: 'https://cdn.example.com/api/videos/workspace-id/video.mp4?token=stale',
            posterUrl: 'https://cdn.example.com/public-assets/poster.png?token=stale',
            errorMessage: '',
        })

        const video = view.dom.querySelector('.ai-generated-video-content') as HTMLVideoElement

        await vi.waitFor(() => {
            const resolvedVideoSrc = video.getAttribute('src') || video.src
            expect(resolvedVideoSrc).toContain('token=token-1')
        })

        const resolvedPosterSrc = video.poster || video.getAttribute('poster')
        expect(resolvedPosterSrc).toContain('token=stale')
    })
})
