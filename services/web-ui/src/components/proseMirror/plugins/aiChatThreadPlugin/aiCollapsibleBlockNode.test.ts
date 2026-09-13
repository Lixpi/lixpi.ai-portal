import {
    describe,
    it,
    expect,
    vi,
} from 'vitest'
import { schema } from '$src/components/proseMirror/plugins/testUtils/prosemirrorTestUtils.ts'
import {
    aiCollapsibleBlockNodeView,
    cacheImageGenerationTrace,
    type AiCollapsibleBlockNodeViewOptions,
} from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiCollapsibleBlockNode.ts'
import {
    type ImageGenerationTrace,
    type VideoGenerationTrace,
} from '@lixpi/constants'

const auth = { getTokenSilently: vi.fn(async () => 'token-1') }

const createTrace = (overrides: Partial<ImageGenerationTrace> = {}): ImageGenerationTrace => {
    return {
        traceVersion: 'image-generation-trace-v1',
        chatModelProvider: 'Anthropic',
        chatModelId: 'claude-sonnet-4-6',
        imageModelProvider: 'Google',
        imageModelId: 'gemini-2.5-flash-image',
        imageSize: '1:1',
        toolPrompt: 'Paint the same man in orange monochrome.',
        finalPrompt: 'MANDATORY CAPABILITY TRANSFER\nPaint the same man in orange monochrome.',
        promptWasChanged: true,
        referenceImages: [
            {
                id: 'branch:person-generated',
                source: 'branch-candidate',
                imageUrl: 'nats-obj://workspace-workspace-1-files/person-file',
                label: 'painted portrait of the man',
                role: 'target',
                nodeId: 'person-generated',
                fileId: 'person-file',
                workspaceId: 'workspace-1',
                branchId: 'branch-person',
                reason: 'selected generated portrait branch',
            },
            {
                id: 'branch:landscape-source',
                source: 'branch-candidate',
                imageUrl: '/api/images/workspace-1/landscape-file',
                label: 'landscape painting',
                role: 'style-reference',
                nodeId: 'landscape-source',
                fileId: 'landscape-file',
                workspaceId: 'workspace-1',
                reason: 'style source',
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
            confidence: 0.91,
            rationale: 'Continue the generated portrait branch and exclude the goat branch.',
            targetCandidateId: 'person-generated',
            parentCandidateId: 'person-generated',
            branchId: 'branch-person',
        },
        ...overrides,
    }
}

const createCollapsibleNodeView = (
    attrs: Record<string, unknown> = {},
    options: AiCollapsibleBlockNodeViewOptions = {},
) => {
    const node = schema.nodes.aiCollapsibleBlock.create(
        {
            title: 'Image generation prompt',
            isOpen: false,
            isStreaming: false,
            ...attrs,
        },
        schema.nodes.paragraph.create(null, schema.text('Prompt body')),
    )

    const transaction = {
        setNodeMarkup: vi.fn().mockReturnThis(),
    }

    const mockView = {
        state: {
            tr: transaction,
            doc: {
                nodeAt: vi.fn(() => node),
            },
        },
        editable: true,
        dispatch: vi.fn(),
    }

    const getPos = vi.fn(() => 3)
    const nodeView = aiCollapsibleBlockNodeView(
        node,
        mockView,
        getPos,
        {
            ...options,
            traceDetailsOptions: {
                auth,
                ...options.traceDetailsOptions,
            },
        },
    )

    return {
        nodeView,
        mockView,
        transaction,
        getPos,
    }
}

describe('aiCollapsibleBlockNodeView', () => {
    it('uses the image-generation trace shell for rendering and exposes a contentDOM', () => {
        const { nodeView } = createCollapsibleNodeView({ imageGenerationTrace: createTrace() })

        expect(nodeView.dom.classList.contains('ai-generation-trace-block')).toBe(true)
        expect(nodeView.dom.classList.contains('has-image-generation-trace')).toBe(true)
        expect(nodeView.contentDOM?.className).toBe('ai-generation-trace-content')
        expect(nodeView.dom.querySelector('.ai-image-generation-tool-prompt-section')).not.toBeNull()
        expect(nodeView.dom.querySelector('.ai-image-generation-reference-section')).not.toBeNull()
    })

    it('ignores DOM mutations outside the trace content body', () => {
        const { nodeView } = createCollapsibleNodeView()
        const mutation = {
            type: 'attributes',
            attributeName: 'class',
            target: nodeView.dom,
        } as unknown as MutationRecord

        expect(nodeView.ignoreMutation!(mutation)).toBe(true)
    })

    it('ignores wrapper open attribute mutations from the manual toggle', () => {
        const { nodeView } = createCollapsibleNodeView()

        const mutation = {
            type: 'attributes',
            attributeName: 'open',
            target: nodeView.dom,
        } as unknown as MutationRecord

        expect(nodeView.ignoreMutation!(mutation)).toBe(true)
    })

    it('updates streaming state through the trace wrapper class', () => {
        const { nodeView } = createCollapsibleNodeView()
        const updatedNode = schema.nodes.aiCollapsibleBlock.create(
            {
                title: 'Revised prompt',
                isOpen: true,
                isStreaming: true,
                imageGenerationTrace: createTrace(),
            },
            schema.nodes.paragraph.create(null, schema.text('Updated prompt body')),
        )

        const result = nodeView.update!(updatedNode)

        expect(result).toBe(true)
        expect(nodeView.dom.classList.contains('is-streaming')).toBe(true)
    })

    it('update returns false for a different node type', () => {
        const { nodeView } = createCollapsibleNodeView()
        const wrongNode = schema.nodes.paragraph.create(null, schema.text('Nope'))

        expect(nodeView.update!(wrongNode)).toBe(false)
    })

    it('renders tool/final prompts, resolver metadata, and exclusions from an image trace', () => {
        const { nodeView } = createCollapsibleNodeView({ imageGenerationTrace: createTrace() })

        expect(nodeView.dom.querySelector('.ai-image-generation-tool-prompt-section')?.textContent).toContain('Prompt for media generation model written by reasoning model')
        expect(nodeView.dom.querySelector('.ai-image-generation-final-prompt')?.textContent).toContain('MANDATORY CAPABILITY TRANSFER')
        expect(nodeView.dom.querySelector('.ai-image-generation-resolver-summary')?.textContent).toBe('Style Transfer | Edit Active Branch | confidence 91%')
        expect(nodeView.dom.querySelector('.ai-image-generation-resolver-rationale')?.textContent).toContain('exclude the goat branch')
        expect(nodeView.dom.querySelector('.ai-image-generation-excluded-label')?.textContent).toBe('painted goat')
        expect(nodeView.dom.querySelector('.ai-image-generation-excluded-node')?.textContent).toBe('goat-generated')
        const referenceGrid = nodeView.dom.querySelector('.ai-image-generation-reference-grid')
        expect(referenceGrid?.childElementCount).toBe(2)
        expect(referenceGrid?.querySelector('.ai-image-generation-reference')?.getAttribute('data-role')).toBe('target')
    })

    it('hides the standalone tool prompt when history projects it inside the pipeline', () => {
        const { nodeView } = createCollapsibleNodeView(
            { imageGenerationTrace: createTrace() },
            { traceDetailsOptions: { hideToolPrompt: true } },
        )

        expect(nodeView.dom.querySelector('.ai-image-generation-tool-prompt-section')?.hasAttribute('hidden')).toBe(true)
        expect(nodeView.dom.querySelector('.ai-image-generation-reference-section')?.hasAttribute('hidden')).toBe(false)
        expect(nodeView.dom.querySelector('.ai-image-generation-resolver-section')?.hasAttribute('hidden')).toBe(false)
    })

    it('keeps the final prompt section hidden when the image prompt was not changed', () => {
        const trace = createTrace({
            finalPrompt: 'Paint the same man in orange monochrome.',
            promptWasChanged: false,
        })
        const { nodeView } = createCollapsibleNodeView({ imageGenerationTrace: trace })

        expect(nodeView.dom.querySelector('.ai-image-generation-final-prompt-section')?.hasAttribute('hidden')).toBe(true)
        expect(nodeView.dom.querySelector('.ai-image-generation-final-prompt')?.textContent).toBe('')
    })

    it('can render a cached trace by id without needing inline trace attrs', () => {
        cacheImageGenerationTrace('trace-1', createTrace({ referenceImages: [] }))
        const { nodeView } = createCollapsibleNodeView({ imageGenerationTraceId: 'trace-1' })

        expect(nodeView.dom.classList.contains('has-image-generation-trace')).toBe(true)
        expect(nodeView.dom.querySelector('.ai-image-generation-reference-grid')?.textContent).toContain('No reference images were sent.')
    })

    it('renders a video generation trace through the same collapsible (parity with images)', () => {
        // The video trace reuses the image trace's reference/excluded/resolver
        // shape, so the same renderer must surface it — only the title differs.
        const videoTrace: VideoGenerationTrace = {
            traceVersion: 'video-generation-trace-v1',
            chatModelProvider: 'Anthropic',
            chatModelId: 'claude-sonnet-4-6',
            videoModelProvider: 'Google',
            videoModelId: 'veo-3.0-generate-001',
            aspectRatio: '16:9',
            resolution: '1080p',
            durationSeconds: 6,
            toolPrompt: 'Animate the seaside village at dawn.',
            finalPrompt: 'Animate the seaside village at dawn.',
            promptWasChanged: false,
            referenceImages: [
                {
                    id: 'branch:video-generated',
                    source: 'branch-candidate',
                    imageUrl: 'nats-obj://workspace-workspace-1-files/video-frame-file',
                    label: 'seaside village still',
                    role: 'target',
                    nodeId: 'video-generated',
                    fileId: 'video-frame-file',
                    workspaceId: 'workspace-1',
                    branchId: 'branch-video',
                    reason: 'continue the seaside clip',
                },
            ],
            excludedReferences: [],
            resolver: {
                resolverKind: 'structured-vlm',
                resolverVersion: 'image-branch-vlm-v1',
                resolverModelProvider: 'Anthropic',
                resolverModelId: 'claude-sonnet-4-6',
                mode: 'edit-active-branch',
                operationKind: 'edit_existing',
                confidence: 0.88,
                rationale: 'Continue the seaside clip branch.',
                targetCandidateId: 'video-generated',
                parentCandidateId: 'video-generated',
                branchId: 'branch-video',
            },
        }
        const { nodeView } = createCollapsibleNodeView({ videoGenerationTrace: videoTrace })

        expect(nodeView.dom.querySelector('.ai-image-generation-resolver-summary')?.textContent).toBe('Edit Existing | Edit Active Branch | confidence 88%')
        expect(nodeView.dom.querySelector('.ai-image-generation-resolver-rationale')?.textContent).toContain('seaside clip branch')
        expect(nodeView.dom.querySelector('.ai-image-generation-tool-prompt-section')).not.toBeNull()
        const referenceGrid = nodeView.dom.querySelector('.ai-image-generation-reference-grid')
        expect(referenceGrid?.querySelector('.ai-image-generation-reference')?.getAttribute('data-role')).toBe('target')
    })
})
