import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    EditorState,
    TextSelection,
} from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { CanvasGenerationEvents } from '@lixpi/canvas-components-lixpi-specific/shared'

import { applyStyle } from '@lixpi/ui-primitives/dom'
import { doc, p, reasoningSection, thread, userMsg, response, schema } from '$src/components/proseMirror/plugins/testUtils/prosemirrorTestUtils.ts'
import {
    aiChatThreadNodeSpec,
    aiChatThreadNodeView,
} from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiChatThreadNode.ts'
import { createAiChatThreadPlugin } from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiChatThreadPlugin.ts'
import { AI_CHAT_THREAD_PLUGIN_KEY } from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiChatThreadPluginConstants.ts'
import { statePlugin } from '$src/components/proseMirror/plugins/statePlugin.ts'
import SegmentsReceiver from '$src/services/segmentsReceiver-service.ts'
import {
    type ImageGenerationTrace,
} from '@lixpi/constants'

const generationEventsForTests: CanvasGenerationEvents[] = []
afterEach(() => {
    for (const events of generationEventsForTests.splice(0)) events.destroy()
})

let consoleErrorSpy: { mockRestore: () => void } | null = null
let consoleWarnSpy: { mockRestore: () => void } | null = null

vi.mock('prosemirror-transform', () => ({
    Step: {
        fromJSON: vi.fn(() => ({
            apply: vi.fn((doc: unknown) => ({
                doc,
                failed: null,
                maps: [],
            })),
        })),
    },
}))

beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    consoleErrorSpy?.mockRestore()
    consoleWarnSpy?.mockRestore()
    consoleErrorSpy = null
    consoleWarnSpy = null
})

const createImageGenerationTrace = (overrides: Partial<ImageGenerationTrace> = {}): ImageGenerationTrace => {
    return {
        traceVersion: 'image-generation-trace-v1',
        chatModelProvider: 'Anthropic',
        chatModelId: 'claude-sonnet-4-6',
        imageModelProvider: 'Google',
        imageModelId: 'gemini-2.5-flash-image',
        imageSize: '1:1',
        toolPrompt: 'Paint the same man in orange monochrome.',
        finalPrompt: 'Paint the same man in orange monochrome.',
        promptWasChanged: false,
        referenceImages: [
            {
                id: 'branch:person-generated',
                source: 'branch-candidate',
                imageUrl: 'nats-obj://workspace-workspace-1-files/person-file',
                label: 'painted portrait of the man',
                role: 'target',
                nodeId: 'person-generated',
                assetId: 'person-asset',
                branchId: 'branch-person',
                reason: 'selected generated portrait branch',
            },
        ],
        excludedReferences: [
            {
                candidateId: 'goat-generated',
                nodeId: 'goat-generated',
                label: 'painted goat',
                role: 'excluded',
                reason: 'different subject branch',
                branchId: 'branch-goat',
            },
        ],
        resolver: {
            resolverKind: 'structured-vlm',
            resolverVersion: 'image-branch-vlm-v1',
            resolverModelProvider: 'Anthropic',
            resolverModelId: 'claude-sonnet-4-6',
            mode: 'edit-active-branch',
            operationKind: 'style_transfer',
            confidence: 0.95,
            rationale: 'Continue the generated portrait branch.',
            targetCandidateId: 'person-generated',
            parentCandidateId: 'person-generated',
            branchId: 'branch-person',
        },
        ...overrides,
    }
}

// =============================================================================
// Helper: instantiate aiChatThreadNodeView with minimal mocks
// =============================================================================

const createThreadNodeView = (attrs: Record<string, unknown> = {}) => {
    const node = schema.nodes.aiChatThread.create(
        {
            threadId: 'thread-test-1',
            status: 'active',
            ...attrs,
        },
    )

    const mockView = {
        state: {
            doc: doc(thread(p('hello'))),
            tr: {
                setNodeMarkup: vi.fn().mockReturnThis(),
                setSelection: vi.fn().mockReturnThis(),
            },
        },
        dispatch: vi.fn(),
        focus: vi.fn(),
    }
    const getPos = vi.fn(() => 0)

    const nodeView = aiChatThreadNodeView(node, mockView, getPos)

    return {
        nodeView,
        node,
        mockView,
        getPos,
    }
}

// =============================================================================
// aiChatThreadNodeView — ignoreMutation
// =============================================================================

describe('aiChatThreadNodeView — ignoreMutation', () => {
    it('returns true for style attribute mutations', () => {
        const { nodeView } = createThreadNodeView()

        const mutation = {
            type: 'attributes',
            attributeName: 'style',
            target: nodeView.dom,
        } as unknown as MutationRecord

        expect(nodeView.ignoreMutation!(mutation)).toBe(true)
    })

    it('returns false for non-style attribute mutations', () => {
        const { nodeView } = createThreadNodeView()

        const cases = ['class', 'data-thread-id', 'data-status', 'id']

        for (const attributeName of cases) {
            const mutation = {
                type: 'attributes',
                attributeName,
                target: nodeView.dom,
            } as unknown as MutationRecord

            expect(nodeView.ignoreMutation!(mutation)).toBe(false)
        }
    })

    it('returns false for childList mutations (ProseMirror manages content)', () => {
        const { nodeView } = createThreadNodeView()

        const mutation = {
            type: 'childList',
            attributeName: null,
            target: nodeView.contentDOM!,
        } as unknown as MutationRecord

        expect(nodeView.ignoreMutation!(mutation)).toBe(false)
    })

    it('returns false for characterData mutations', () => {
        const { nodeView } = createThreadNodeView()

        const mutation = {
            type: 'characterData',
            attributeName: null,
            target: nodeView.contentDOM!,
        } as unknown as MutationRecord

        expect(nodeView.ignoreMutation!(mutation)).toBe(false)
    })
})

// =============================================================================
// aiChatThreadNodeView — height preserved across update()
// =============================================================================

describe('aiChatThreadNodeView — height survives update()', () => {
    it('preserves externally-set height when update() is called', () => {
        const { nodeView } = createThreadNodeView()
        const dom = nodeView.dom as HTMLElement

        // Simulate a canvas layout pass growing the thread height.
        applyStyle(dom, { height: '800px' })
        expect(dom.style.height).toBe('800px')

        // Simulate ProseMirror calling update() with updated attributes
        const updatedNode = schema.nodes.aiChatThread.create(
            {
                threadId: 'thread-test-1',
                status: 'completed',
            },
        )

        const result = nodeView.update!(updatedNode, [])
        expect(result).toBe(true)

        // Height must survive the update
        expect(dom.style.height).toBe('800px')
    })

    it('preserves height across multiple sequential updates', () => {
        const { nodeView } = createThreadNodeView()
        const dom = nodeView.dom as HTMLElement

        applyStyle(dom, { height: '1200px' })

        // Simulate multiple updates during streaming
        const statuses = ['active', 'active', 'completed'] as const

        for (const status of statuses) {
            const updatedNode = schema.nodes.aiChatThread.create(
                {
                    threadId: 'thread-test-1',
                    status,
                },
            )
            nodeView.update!(updatedNode, [])
        }

        expect(dom.style.height).toBe('1200px')
    })
})

// =============================================================================
// aiChatThreadNodeView — DOM structure
// =============================================================================

describe('aiChatThreadNodeView — DOM structure', () => {
    it('creates wrapper with ai-chat-thread-wrapper class', () => {
        const { nodeView } = createThreadNodeView()
        const dom = nodeView.dom as HTMLElement

        expect(dom.className).toBe('ai-chat-thread-wrapper')
    })

    it('sets data-thread-id attribute on wrapper', () => {
        const { nodeView } = createThreadNodeView({ threadId: 'thread-xyz' })
        const dom = nodeView.dom as HTMLElement

        expect(dom.getAttribute('data-thread-id')).toBe('thread-xyz')
    })

    it('sets data-status attribute on wrapper', () => {
        const { nodeView } = createThreadNodeView({ status: 'paused' })
        const dom = nodeView.dom as HTMLElement

        expect(dom.getAttribute('data-status')).toBe('paused')
    })

    it('has contentDOM as ai-chat-thread-content element', () => {
        const { nodeView } = createThreadNodeView()
        const contentDOM = nodeView.contentDOM as HTMLElement

        expect(contentDOM.className).toBe('ai-chat-thread-content')
    })

    it('contentDOM is a child of dom', () => {
        const { nodeView } = createThreadNodeView()

        expect(nodeView.dom.contains(nodeView.contentDOM!)).toBe(true)
    })
})

describe('aiChatThreadNodeView — content focus', () => {
    it('places the caret inside message text instead of on the block-only thread container', () => {
        const documentNode = doc(thread(userMsg(p('hello'))))
        const state = EditorState.create({
            doc: documentNode,
            schema,
        })
        const mockView = {
            state,
            editable: true,
            dispatch: vi.fn((transaction) => void (mockView.state = mockView.state.apply(transaction))),
            focus: vi.fn(),
        }
        const threadNode = documentNode.firstChild!
        const nodeView = aiChatThreadNodeView(threadNode, mockView, () => 0)

        nodeView.contentDOM!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

        expect(mockView.focus).toHaveBeenCalledOnce()
        expect(mockView.state.selection).toBeInstanceOf(TextSelection)
        expect(mockView.state.selection.$from.parent.inlineContent).toBe(true)
        expect(mockView.state.selection.$from.parent.type.name).toBe('paragraph')
    })
})

// =============================================================================
// aiChatThreadNodeView — update()
// =============================================================================

describe('aiChatThreadNodeView — update()', () => {
    it('updates data-thread-id when attribute changes', () => {
        const { nodeView } = createThreadNodeView({ threadId: 'old-thread' })
        const dom = nodeView.dom as HTMLElement

        const updatedNode = schema.nodes.aiChatThread.create(
            {
                threadId: 'new-thread',
                status: 'active',
            },
        )
        nodeView.update!(updatedNode, [])

        expect(dom.getAttribute('data-thread-id')).toBe('new-thread')
    })

    it('updates data-status when attribute changes', () => {
        const { nodeView } = createThreadNodeView({ status: 'active' })
        const dom = nodeView.dom as HTMLElement

        const updatedNode = schema.nodes.aiChatThread.create(
            {
                threadId: 'thread-test-1',
                status: 'completed',
            },
        )
        nodeView.update!(updatedNode, [])

        expect(dom.getAttribute('data-status')).toBe('completed')
    })

    it('returns false for a different node type', () => {
        const { nodeView } = createThreadNodeView()

        const wrongNode = schema.nodes.paragraph.create(null, schema.text('wrong'))
        const result = nodeView.update!(wrongNode, [])

        expect(result).toBe(false)
    })

    it('returns true for same node type', () => {
        const { nodeView } = createThreadNodeView()

        const updatedNode = schema.nodes.aiChatThread.create(
            {
                threadId: 'thread-test-1',
                status: 'active',
            },
        )
        const result = nodeView.update!(updatedNode, [])

        expect(result).toBe(true)
    })
})

// =============================================================================
// aiChatThreadNodeSpec — schema validation
// =============================================================================

describe('aiChatThreadNodeSpec — schema', () => {
    it('parseDOM targets div.ai-chat-thread-wrapper', () => {
        const parseRule = aiChatThreadNodeSpec.parseDOM[0]
        expect(parseRule.tag).toBe('div.ai-chat-thread-wrapper')
    })

    it('extracts threadId and status from DOM attributes', () => {
        const parseRule = aiChatThreadNodeSpec.parseDOM[0]

        const mockDom = {
            getAttribute: (attr: string) => {
                const attrs: Record<string, string> = {
                    'data-thread-id': 'thread-parsed-1',
                    'data-status': 'paused',
                    'data-ai-reasoning-models': '["claude-3-5-sonnet"]',
                    'data-image-generation-enabled': 'true',
                    'data-image-generation-size': '1536x1024',
                    'data-previous-response-id': 'resp-prev',
                }

                return attrs[attr] ?? null
            },
            hasAttribute: (attr: string) =>
                [
                    'data-thread-id',
                    'data-status',
                    'data-ai-reasoning-models',
                    'data-image-generation-enabled',
                    'data-image-generation-size',
                    'data-previous-response-id',
                ].includes(attr),
        }

        const parsed = parseRule.getAttrs(mockDom)
        expect(parsed.threadId).toBe('thread-parsed-1')
        expect(parsed.status).toBe('paused')
        expect(parsed.aiReasoningModels).toBe('["claude-3-5-sonnet"]')
        expect(parsed.imageGenerationEnabled).toBe(true)
        expect(parsed.imageGenerationSize).toBe('1536x1024')
        expect(parsed.previousResponseId).toBe('resp-prev')
    })

    it('toDOM produces correct element structure', () => {
        const node = schema.nodes.aiChatThread.create({
            threadId: 'thread-dom-1',
            status: 'active',
        })

        const domOutput = node.type.spec.toDOM(node)
        expect(domOutput[0]).toBe('div')
        expect(domOutput[1].class).toBe('ai-chat-thread-wrapper')
        expect(domOutput[1]['data-thread-id']).toBe('thread-dom-1')
        expect(domOutput[1]['data-status']).toBe('active')
        expect(domOutput[2]).toBe(0)
    })
})

// =============================================================================
// aiChatThreadPlugin — onReceivingStateChange callback
// =============================================================================

describe('aiChatThreadPlugin — onReceivingStateChange callback', () => {
    const createPluginWithCallback = (onReceivingStateChange: (threadId: string, receiving: boolean) => void) => {
        return createAiChatThreadPlugin({
            sendAiRequestHandler: vi.fn(),
            stopAiRequestHandler: vi.fn(),
            placeholders: {
                titlePlaceholder: 'Title',
                paragraphPlaceholder: 'Type here…',
            },
            onReceivingStateChange,
        })
    }

    const createStateWithPlugin = (plugin: ReturnType<typeof createPluginWithCallback>) => {
        return EditorState.create({
            doc: doc(thread({ threadId: 'thread-1' }, p('hello'))),
            schema,
            plugins: [plugin],
        })
    }

    it('calls onReceivingStateChange when setReceiving meta is dispatched with receiving=true', () => {
        const callback = vi.fn()
        const plugin = createPluginWithCallback(callback)
        const state = createStateWithPlugin(plugin)

        const tr = state.tr.setMeta('setReceiving', {
            threadId: 'thread-1',
            receiving: true,
        })
        state.apply(tr)

        expect(callback).toHaveBeenCalledTimes(1)
        expect(callback).toHaveBeenCalledWith('thread-1', true)
    })

    it('calls onReceivingStateChange when setReceiving meta is dispatched with receiving=false', () => {
        const callback = vi.fn()
        const plugin = createPluginWithCallback(callback)
        const state = createStateWithPlugin(plugin)

        // First set receiving=true
        const tr1 = state.tr.setMeta('setReceiving', {
            threadId: 'thread-1',
            receiving: true,
        })
        const state2 = state.apply(tr1)

        // Then set receiving=false
        const tr2 = state2.tr.setMeta('setReceiving', {
            threadId: 'thread-1',
            receiving: false,
        })
        state2.apply(tr2)

        expect(callback).toHaveBeenCalledTimes(2)
        expect(callback).toHaveBeenCalledWith('thread-1', false)
    })

    it('does not call onReceivingStateChange for transactions without setReceiving meta', () => {
        const callback = vi.fn()
        const plugin = createPluginWithCallback(callback)
        const state = createStateWithPlugin(plugin)

        // Dispatch a regular transaction (insertText)
        const tr = state.tr.insertText('x', 2)
        state.apply(tr)

        expect(callback).not.toHaveBeenCalled()
    })

    it('does not throw when onReceivingStateChange is not provided', () => {
        const plugin = createAiChatThreadPlugin({
            sendAiRequestHandler: vi.fn(),
            stopAiRequestHandler: vi.fn(),
            placeholders: {
                titlePlaceholder: 'Title',
                paragraphPlaceholder: 'Type here…',
            },
        })
        const state = EditorState.create({
            doc: doc(thread({ threadId: 'thread-1' }, p('hello'))),
            schema,
            plugins: [plugin],
        })

        const tr = state.tr.setMeta('setReceiving', {
            threadId: 'thread-1',
            receiving: true,
        })
        expect(() => state.apply(tr)).not.toThrow()
    })

    it('updates plugin state receivingThreadIds when setReceiving meta is dispatched', () => {
        const callback = vi.fn()
        const plugin = createPluginWithCallback(callback)
        const state = createStateWithPlugin(plugin)

        const tr = state.tr.setMeta('setReceiving', {
            threadId: 'thread-1',
            receiving: true,
        })
        const newState = state.apply(tr)

        const pluginState = AI_CHAT_THREAD_PLUGIN_KEY.getState(newState)
        expect(pluginState.receivingThreadIds.has('thread-1')).toBe(true)
    })
})

// =============================================================================
// aiChatThreadPlugin — image generation trace
// =============================================================================

describe('aiChatThreadPlugin — image generation trace', () => {
    const createView = (children: any[] = [p('Generating image')]) => {
        const plugin = createAiChatThreadPlugin({
            sendAiRequestHandler: vi.fn(),
            stopAiRequestHandler: vi.fn(),
            placeholders: {
                titlePlaceholder: 'Title',
                paragraphPlaceholder: 'Type here…',
            },
        })
        const mount = document.createElement('div')
        document.body.appendChild(mount)
        const view = new EditorView(mount, {
            state: EditorState.create({
                doc: doc(
                    thread(
                        { threadId: 'thread-1' },
                        response(
                            {
                                id: 'resp-1',
                                isReceivingAnimation: true,
                                aiProvider: 'Anthropic',
                            },
                            ...children,
                        ),
                    ),
                ),
                schema,
                plugins: [plugin],
            }),
        })

        return {
            view,
            mount,
        }
    }

    const getCollapsibleNodes = (view: EditorView): any[] => {
        const collapsibleNodes: any[] = []
        view.state.doc.descendants((node: any) => {
            if (node.type.name === 'aiCollapsibleBlock')
                collapsibleNodes.push(node)
        })

        return collapsibleNodes
    }

    it('inserts a persisted image-generation trace block into the active response', () => {
        const {
            view,
            mount,
        } = createView()
        const trace = createImageGenerationTrace()

        SegmentsReceiver.receiveSegment({
            type: 'image_generation_trace',
            conversationAssetId: 'thread-1',
            imageGenerationTrace: trace,
        })

        const collapsibleNodes = getCollapsibleNodes(view)
        expect(collapsibleNodes).toHaveLength(1)
        expect(collapsibleNodes[0].attrs).toMatchObject({
            title: 'Image generation details',
            isOpen: false,
            isStreaming: false,
            imageGenerationTrace: trace,
            imageGenerationTraceId: null,
        })

        view.destroy()
        mount.remove()
    })

    it('updates an existing prompt details block instead of inserting a duplicate', () => {
        const existingBlock = schema.nodes.aiCollapsibleBlock.create(
            {
                title: 'Image generation prompt',
                isOpen: true,
                isStreaming: true,
            },
            schema.nodes.paragraph.create(null, schema.text('Original tool prompt')),
        )
        const {
            view,
            mount,
        } = createView([p('Generating image'), existingBlock])
        const trace = createImageGenerationTrace({
            finalPrompt: 'Final trace prompt',
            promptWasChanged: true,
        })

        SegmentsReceiver.receiveSegment({
            type: 'image_generation_trace',
            conversationAssetId: 'thread-1',
            imageGenerationTrace: trace,
        })

        const collapsibleNodes = getCollapsibleNodes(view)
        expect(collapsibleNodes).toHaveLength(1)
        expect(collapsibleNodes[0].attrs).toMatchObject({
            title: 'Image generation details',
            isOpen: false,
            isStreaming: false,
            imageGenerationTrace: trace,
        })
        expect(collapsibleNodes[0].textContent).toBe('Original tool prompt')

        view.destroy()
        mount.remove()
    })
})

// =============================================================================
// aiChatThreadPlugin — generated image completion
// =============================================================================

describe('aiChatThreadPlugin — generated image completion', () => {
    const getCollapsibleNodes = (view: EditorView): any[] => {
        const collapsibleNodes: any[] = []
        view.state.doc.descendants((node: any) => {
            if (node.type.name === 'aiCollapsibleBlock')
                collapsibleNodes.push(node)
        })

        return collapsibleNodes
    }

    const createView = (
        onImageCompleteToCanvas = vi.fn(),
        onImagePartialToCanvas = vi.fn(),
        additionalPlugins: any[] = [],
        onImageErrorToCanvas = vi.fn(),
        responseContent: any[] = [p('Generating image')],
        responseAttrs: Record<string, unknown> = {},
    ) => {
        const events = new CanvasGenerationEvents(error => {
            throw error
        })
        generationEventsForTests.push(events)
        events.subscribeImages({
            onImageCompleteToCanvas,
            onImagePartialToCanvas,
            onImageErrorToCanvas,
        })
        const plugin = createAiChatThreadPlugin({
            sendAiRequestHandler: vi.fn(),
            stopAiRequestHandler: vi.fn(),
            placeholders: {
                titlePlaceholder: 'Title',
                paragraphPlaceholder: 'Type here…',
            },
            onStreamEvent: (event, options) => events.route(event, options),
        })

        const mount = document.createElement('div')
        document.body.appendChild(mount)

        const view = new EditorView(mount, {
            state: EditorState.create({
                doc: doc(
                    thread(
                        { threadId: 'thread-1' },
                        response(
                            {
                                id: 'resp-1',
                                isReceivingAnimation: true,
                                isInitialRenderAnimation: true,
                                aiProvider: 'OpenAI',
                                ...responseAttrs,
                            },
                            ...responseContent,
                        ),
                    ),
                ),
                schema,
                plugins: [...additionalPlugins, plugin],
            }),
        })

        return {
            view,
            mount,
            onImageCompleteToCanvas,
            onImagePartialToCanvas,
            onImageErrorToCanvas,
        }
    }

    const getGeneratedImageNodes = (view: EditorView): any[] => {
        const imageNodes: any[] = []
        view.state.doc.descendants((node: any) => {
            if (node.type.name === 'aiGeneratedImage')
                imageNodes.push(node)
        })

        return imageNodes
    }

    it('inserts a placeholder image reference into the active AI response on partial events', () => {
        const onImagePartialToCanvas = vi.fn()
        const {
            view,
            mount,
        } = createView(vi.fn(), onImagePartialToCanvas)

        SegmentsReceiver.receiveSegment({
            type: 'image_partial',
            conversationAssetId: 'thread-1',
            imageUrl: '',
            assetId: '',
            partialIndex: 0,
            aiProvider: 'OpenAI',
        })

        const imageNodes = getGeneratedImageNodes(view)

        expect(imageNodes).toHaveLength(1)
        expect(imageNodes[0].attrs).toMatchObject({
            imageData: '',
            assetId: '',
            aiModel: 'OpenAI',
            isPartial: true,
            partialIndex: 0,
            width: '100%',
            alignment: 'right',
            textWrap: 'none',
        })
        expect(onImagePartialToCanvas).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 'thread-1',
            imageUrl: '',
            partialIndex: 0,
        }))

        view.destroy()
        mount.remove()
    })

    it('tracks progressive partial placeholders across image indices when run metadata is unavailable', () => {
        const {
            view,
            mount,
        } = createView()

        SegmentsReceiver.receiveSegment({
            type: 'image_partial',
            conversationAssetId: 'thread-1',
            imageUrl: '',
            assetId: '',
            partialIndex: 0,
            aiProvider: 'OpenAI',
        })
        SegmentsReceiver.receiveSegment({
            type: 'image_partial',
            conversationAssetId: 'thread-1',
            imageUrl: '/api/images/workspace-1/file-partial',
            assetId: 'file-partial',
            partialIndex: 2,
            aiProvider: 'OpenAI',
        })

        const imageNodes = getGeneratedImageNodes(view)

        expect(imageNodes).toHaveLength(2)
        expect(imageNodes.map((node) => node.attrs.partialIndex).sort((a, b) => a - b)).toEqual([0, 2])

        expect(imageNodes.find((node) => node.attrs.partialIndex === 0)?.attrs).toMatchObject({
            imageData: '',
            assetId: '',
            isPartial: true,
            partialIndex: 0,
            alignment: 'right',
        })
        expect(imageNodes.find((node) => node.attrs.partialIndex === 2)?.attrs).toMatchObject({
            imageData: '/api/images/workspace-1/file-partial',
            assetId: 'file-partial',
            isPartial: true,
            partialIndex: 2,
            alignment: 'right',
        })

        view.destroy()
        mount.remove()
    })

    it('persists image trace details after progressive previews complete', () => {
        const onPersist = vi.fn()
        const {
            view,
            mount,
        } = createView(vi.fn(), vi.fn(), [
            statePlugin({}, onPersist, vi.fn()),
        ])
        const trace = createImageGenerationTrace()
        const generationRun = {
            generationRequestId: 'gen-1',
            reasoningRunId: 'reasoning-run',
            mediaRunId: 'media-run-1',
            reasoningModelId: 'Anthropic:claude-sonnet-4-6',
            mediaModelId: 'OpenAI:dall-e-3',
            mediaType: 'image',
            variantIndex: 0,
        } as const

        SegmentsReceiver.receiveSegment({
            type: 'image_generation_trace',
            conversationAssetId: 'thread-1',
            imageGenerationTrace: trace,
        })

        for (const partialIndex of [0, 1, 2]) {
            SegmentsReceiver.receiveSegment({
                type: 'image_partial',
                conversationAssetId: 'thread-1',
                imageUrl: `/api/images/workspace-1/file-partial-${partialIndex}`,
                assetId: `file-partial-${partialIndex}`,
                partialIndex,
                aiProvider: 'OpenAI',
                generationRun,
            })
        }

        SegmentsReceiver.receiveSegment({
            type: 'image_complete',
            conversationAssetId: 'thread-1',
            imageUrl: '/api/images/workspace-1/file-final',
            assetId: 'file-final',
            responseId: 'response-1',
            revisedPrompt: 'A revised prompt',
            aiProvider: 'OpenAI',
            imageModelProvider: 'OpenAI',
            generationRun,
        })
        SegmentsReceiver.receiveSegment({
            status: 'END_STREAM',
            threadId: 'thread-1',
        })

        const imageNodes = getGeneratedImageNodes(view)
        const collapsibleNodes = getCollapsibleNodes(view)

        expect(imageNodes).toHaveLength(1)
        expect(imageNodes[0].attrs).toMatchObject({
            assetId: 'file-final',
            isPartial: false,
            partialIndex: 2,
        })
        expect(collapsibleNodes).toHaveLength(1)
        expect(collapsibleNodes[0].attrs.imageGenerationTrace.toolPrompt).toBe(trace.toolPrompt)
        expect(onPersist).not.toHaveBeenCalled()

        view.destroy()
        mount.remove()
    })

    it('inserts a thumbnail image reference into the active AI response', () => {
        const {
            view,
            mount,
        } = createView()

        SegmentsReceiver.receiveSegment({
            type: 'image_complete',
            conversationAssetId: 'thread-1',
            imageUrl: '/api/images/workspace-1/file-1',
            assetId: 'file-1',
            responseId: 'response-1',
            revisedPrompt: 'A revised prompt',
            aiProvider: 'OpenAI',
            imageModelProvider: 'OpenAI',
        })

        const imageNodes = getGeneratedImageNodes(view)

        expect(imageNodes).toHaveLength(1)
        expect(imageNodes[0].attrs).toMatchObject({
            imageData: '/api/images/workspace-1/file-1',
            assetId: 'file-1',
            responseId: 'response-1',
            revisedPrompt: 'A revised prompt',
            isPartial: false,
            width: '100%',
            alignment: 'right',
            textWrap: 'none',
        })

        view.destroy()
        mount.remove()
    })

    it('converts the existing partial placeholder into the final thumbnail on completion', () => {
        const {
            view,
            mount,
        } = createView()

        SegmentsReceiver.receiveSegment({
            type: 'image_partial',
            conversationAssetId: 'thread-1',
            imageUrl: '',
            assetId: '',
            partialIndex: 0,
            aiProvider: 'OpenAI',
        })
        SegmentsReceiver.receiveSegment({
            type: 'image_complete',
            conversationAssetId: 'thread-1',
            imageUrl: '/api/images/workspace-1/file-1',
            assetId: 'file-1',
            responseId: 'response-1',
            revisedPrompt: 'A revised prompt',
            aiProvider: 'OpenAI',
            imageModelProvider: 'OpenAI',
        })

        const imageNodes = getGeneratedImageNodes(view)

        expect(imageNodes).toHaveLength(1)
        expect(imageNodes[0].attrs).toMatchObject({
            imageData: '/api/images/workspace-1/file-1',
            assetId: 'file-1',
            responseId: 'response-1',
            revisedPrompt: 'A revised prompt',
            isPartial: false,
            partialIndex: 0,
            alignment: 'right',
        })

        view.destroy()
        mount.remove()
    })

    it('removes only the failed media-run placeholder on image_error', () => {
        const onImageErrorToCanvas = vi.fn()
        const requestId = 'request-1'
        const reasoningRunId = 'reasoning-1'
        const reasoningModelId = 'Anthropic:claude-sonnet-4-6'
        const makeGenerationRun = (mediaRunId: string, mediaIndex: number) => ({
            generationRequestId: requestId,
            reasoningRunId,
            mediaRunId,
            reasoningModelId,
            mediaModelId: `Google:gemini-image-${mediaIndex}`,
            mediaType: 'image' as const,
            reasoningIndex: 0,
            mediaIndex,
            variantIndex: mediaIndex,
        })
        const run0 = makeGenerationRun('reasoning-1:image:0', 0)
        const run1 = makeGenerationRun('reasoning-1:image:1', 1)
        const {
            view,
            mount,
        } = createView(
            vi.fn(),
            vi.fn(),
            [],
            onImageErrorToCanvas,
            [
                reasoningSection(
                    {
                        generationRequestId: requestId,
                        reasoningRunId,
                        reasoningModelId,
                        reasoningIndex: 0,
                        isReceivingAnimation: true,
                    },
                    p('Generating image variants'),
                ),
            ],
            { generationRequestId: requestId },
        )

        SegmentsReceiver.receiveSegment({
            type: 'image_partial',
            conversationAssetId: 'thread-1',
            imageUrl: '',
            assetId: '',
            partialIndex: 0,
            aiProvider: 'Anthropic',
            generationRun: run0,
        })
        SegmentsReceiver.receiveSegment({
            type: 'image_partial',
            conversationAssetId: 'thread-1',
            imageUrl: '',
            assetId: '',
            partialIndex: 0,
            aiProvider: 'Anthropic',
            generationRun: run1,
        })

        expect(getGeneratedImageNodes(view).map((node) => node.attrs.mediaRunId)).toEqual([
            'reasoning-1:image:0',
            'reasoning-1:image:1',
        ])

        SegmentsReceiver.receiveSegment({
            type: 'image_error',
            conversationAssetId: 'thread-1',
            error: 'Google image model returned no inline image data.',
            generationRun: run0,
        })

        const remainingImages = getGeneratedImageNodes(view)
        expect(remainingImages).toHaveLength(1)
        expect(remainingImages[0].attrs.mediaRunId).toBe('reasoning-1:image:1')
        expect(onImageErrorToCanvas).toHaveBeenCalledWith({
            threadId: 'thread-1',
            error: 'Google image model returned no inline image data.',
            generationRun: run0,
        })

        view.destroy()
        mount.remove()
    })

    it('passes the same response id to the canvas image callback', () => {
        const onImageCompleteToCanvas = vi.fn()
        const {
            view,
            mount,
        } = createView(onImageCompleteToCanvas)

        SegmentsReceiver.receiveSegment({
            type: 'image_complete',
            conversationAssetId: 'thread-1',
            imageUrl: '/api/images/workspace-1/file-1',
            assetId: 'file-1',
            responseId: 'response-1',
            revisedPrompt: 'A revised prompt',
            aiProvider: 'OpenAI',
            imageModelProvider: 'OpenAI',
        })

        expect(onImageCompleteToCanvas).toHaveBeenCalledWith(expect.objectContaining({
            imageUrl: '/api/images/workspace-1/file-1',
            assetId: 'file-1',
            responseMessageId: 'resp-1',
        }))

        view.destroy()
        mount.remove()
    })
})
