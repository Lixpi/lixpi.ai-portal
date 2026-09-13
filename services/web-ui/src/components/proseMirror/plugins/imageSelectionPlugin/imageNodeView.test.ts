import {
    describe,
    expect,
    it,
    beforeEach,
    afterEach,
    vi,
} from 'vitest'
import { EditorState } from 'prosemirror-state'
import {
    type Node as ProseMirrorNode,
} from 'prosemirror-model'
import { testSchema } from '$src/components/proseMirror/plugins/testUtils/testSchema.ts'
import { ImageNodeView } from '$src/components/proseMirror/plugins/imageSelectionPlugin/imageNodeView.ts'
import { aiModelsStore } from '$src/stores/aiModelsStore.ts'

const getTokenSilently = vi.fn()
const auth = { getTokenSilently }

afterEach(() => void vi.clearAllMocks())

beforeEach(() => void getTokenSilently.mockReset().mockResolvedValue('token-1'))

const createImageNode = (overrides: Record<string, unknown> = {}): ProseMirrorNode => {
    return testSchema.nodes.image.create({
        src: 'https://cdn.example.com/example.jpg',
        alt: 'Example source image',
        title: '',
        ...overrides,
    })
}

const createGeneratedImageNode = (overrides: Record<string, unknown> = {}): ProseMirrorNode => {
    return testSchema.nodes.aiGeneratedImage.create({
        imageData: '/api/images/workspace-1/final-file',
        fileId: 'generated-file',
        workspaceId: 'workspace-1',
        revisedPrompt: 'final generated image',
        responseId: 'response-1',
        isPartial: false,
        partialIndex: 0,
        generationRequestId: '',
        reasoningRunId: '',
        mediaRunId: '',
        reasoningModelId: '',
        mediaModelId: 'Google:gemini-2.5-flash',
        mediaType: 'image',
        variantIndex: null,
        alignment: 'left',
        textWrap: 'none',
        ...overrides,
    })
}

const createImageView = (node: ProseMirrorNode, editable = true, getPos: () => number | undefined = () => 0) => {
    const doc = testSchema.nodes.doc.create(null, [node])
    const state = EditorState.create({
        doc,
        schema: testSchema,
    })
    const dispatch = vi.fn()
    const focus = vi.fn()
    const view = {
        state,
        dispatch,
        focus,
        editable,
        dom: document.createElement('div'),
    }

    const nodeView = new ImageNodeView({
        auth,
        node,
        view: view as any,
        getPos,
    })

    return {
        nodeView,
        node,
        doc,
        state,
        dispatch,
        focus,
        view: view as any,
    }
}

const getImageElement = (nodeView: ImageNodeView): HTMLImageElement => nodeView.dom.querySelector('img') as HTMLImageElement

const getResolvedImageSrc = (nodeView: ImageNodeView): string => getImageElement(nodeView).getAttribute('src') ?? ''

// =============================================================================
// Initialization and source resolution
// =============================================================================

describe('ImageNodeView — initialization and source resolution', () => {
    it('keeps inline data URLs untouched and skips auth for them', async () => {
        const imageData = 'data:image/png;base64,AAABBB'
        const { nodeView } = createImageView(testSchema.nodes.image.create({
            src: imageData,
            alt: '',
            title: '',
        }))

        await vi.waitFor(() => expect(getImageElement(nodeView).getAttribute('src')).toBe(imageData))
        expect(getTokenSilently).not.toHaveBeenCalled()
    })

    it('resolves API image paths through resolveAuthenticatedMediaUrl', async () => {
        const { nodeView } = createImageView(createImageNode({
            src: '/api/images/workspace-1/final-file',
            title: 'Native image hover text',
        }))

        await vi.waitFor(() => expect(getResolvedImageSrc(nodeView)).toContain('token=token-1'))
        expect(getResolvedImageSrc(nodeView)).toContain('/api/images/workspace-1/final-file')
        expect(getImageElement(nodeView).getAttribute('title')).toBeNull()
        expect(getTokenSilently).toHaveBeenCalledTimes(1)
    })

    it('updates resolved image source when image node attrs change', async () => {
        const { nodeView } = createImageView(createImageNode({
            src: '/api/images/workspace-1/old',
        }))

        await vi.waitFor(() => expect(getResolvedImageSrc(nodeView)).toContain('/api/images/workspace-1/old'))

        const updated = nodeView.update(createImageNode({
            src: '/api/images/workspace-1/new',
        }))
        expect(updated).toBe(true)

        await vi.waitFor(() => expect(getResolvedImageSrc(nodeView)).toContain('/api/images/workspace-1/new'))
    })
})

// =============================================================================
// Generated media chrome and placeholder behavior
// =============================================================================

describe('ImageNodeView — generated image behaviors', () => {
    it('renders generation placeholders only while partial data is absent', () => {
        const { nodeView } = createImageView(createGeneratedImageNode({
            imageData: '',
            isPartial: true,
        }))

        const placeholder = nodeView.dom.querySelector('.pm-image-generating-placeholder')
        const title = nodeView.dom.querySelector('.ai-generated-media-section-title')
        const image = getImageElement(nodeView)

        expect(nodeView.dom.classList.contains('is-partial')).toBe(true)
        expect(placeholder).not.toBeNull()
        expect(title).toBeNull()
        expect(image.style.display).toBe('none')
    })

    it('shows the generated-image title when complete image data is present', async () => {
        const { nodeView } = createImageView(createGeneratedImageNode({
            imageData: '',
            isPartial: true,
        }))

        const updated = nodeView.update(createGeneratedImageNode({
            imageData: 'https://cdn.example.com/final-generated.png',
            isPartial: false,
        }))

        expect(updated).toBe(true)
        await vi.waitFor(() => expect(nodeView.dom.querySelector('.ai-generated-media-section-title')).not.toBeNull())
    })

    it('shows generated model chrome and updates it when media model changes', async () => {
        const { nodeView } = createImageView(createGeneratedImageNode({
            mediaModelId: 'Google:gemini-2.5-flash',
        }))

        await vi.waitFor(() => expect(getImageElement(nodeView).getAttribute('src')).toContain('token=token-1'))
        const modelChrome = nodeView.dom.querySelector('.ai-generated-media-run-meta') as HTMLElement
        expect(modelChrome).not.toBeNull()
        expect(modelChrome.textContent).toContain('Google')

        nodeView.update(createGeneratedImageNode({
            mediaModelId: 'OpenAI:gpt-4.1',
        }))
        expect(modelChrome.textContent).toContain('OpenAI')
        expect(modelChrome.textContent).toContain('gpt-4.1')
    })

    it('adds an unavailable placeholder and keeps it deduplicated on repeated image errors', () => {
        const { nodeView } = createImageView(createImageNode({
            src: '/api/images/workspace-1/not-found.jpg',
        }))
        const image = getImageElement(nodeView)

        image.dispatchEvent(new Event('error'))
        image.dispatchEvent(new Event('error'))

        const placeholders = nodeView.dom.querySelectorAll('.image-error-placeholder')
        expect(placeholders).toHaveLength(1)
    })
})

// =============================================================================
// Interaction and state transitions
// =============================================================================

describe('ImageNodeView — interactions', () => {
    it('selects the node and focuses editor when clicked while editable', () => {
        const {
            nodeView,
            dispatch,
            focus,
            view,
        } = createImageView(createImageNode())

        nodeView.dom.dispatchEvent(new MouseEvent('click'))

        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(focus).toHaveBeenCalledTimes(1)
        expect(view.state.tr).toBeDefined()
        expect(dispatch.mock.calls[0]?.[0].selection.toJSON()).toMatchObject({
            type: 'node',
            anchor: 0,
        })
    })

    it('does not dispatch selection when editor is read-only', () => {
        const {
            nodeView,
            dispatch,
            focus,
        } = createImageView(createImageNode(), false)

        nodeView.dom.dispatchEvent(new MouseEvent('click'))

        expect(dispatch).not.toHaveBeenCalled()
        expect(focus).not.toHaveBeenCalled()
    })

    it('allows all events except resize handle events to bubble through stopEvent', () => {
        const { nodeView } = createImageView(createImageNode())
        const handle = nodeView.dom.querySelector('.pm-image-resize-handle')
        const container = nodeView.dom.querySelector('.pm-image-media-frame') as HTMLElement

        expect(handle).not.toBeNull()
        expect(nodeView.stopEvent({ target: handle as unknown as HTMLElement } as Event)).toBe(true)
        expect(nodeView.stopEvent({ target: container } as Event)).toBe(false)
    })
})

// =============================================================================
// Lifecycle and cleanup
// =============================================================================

describe('ImageNodeView — lifecycle cleanup', () => {
    it('does not render resize handles when the editor is not editable', () => {
        const { nodeView } = createImageView(createImageNode(), false)

        expect(nodeView.dom.querySelectorAll('.pm-image-resize-handle')).toHaveLength(0)
    })

    it('removes resize handles and unsubscribes model badge updates on destroy', () => {
        const unsubscribe = vi.fn()
        const subscribeSpy = vi.spyOn(aiModelsStore, 'subscribe').mockReturnValue(unsubscribe)

        const { nodeView } = createImageView(createGeneratedImageNode())

        nodeView.destroy()

        expect(unsubscribe).toHaveBeenCalledTimes(1)
        expect(nodeView.dom.querySelectorAll('.pm-image-resize-handle')).toHaveLength(0)
        subscribeSpy.mockRestore()
    })

    it('rejects incompatible nodes in update()', () => {
        const {
            nodeView,
            doc,
        } = createImageView(createImageNode())
        const wrongNode = doc.type.schema.nodes.doc.create(null)

        expect(nodeView.update(wrongNode as ProseMirrorNode)).toBe(false)
    })
})
