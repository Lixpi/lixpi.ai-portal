import {
    describe,
    it,
    expect,
    vi,
} from 'vitest'

import { cacheImageGenerationTrace, createImageGenerationTraceDetails, deduplicateImageGenerationTraceReferences, formatImageGenerationTraceReferenceSource, formatImageGenerationTraceRole, getImageGenerationTrace, formatTraceModelLabel } from '$src/components/proseMirror/plugins/aiChatThreadPlugin/imageGenerationTraceDetails.ts'
import {
    type CapabilityGenerationTrace,
    type ImageGenerationTrace,
    type ImageGenerationTraceReference,
} from '@lixpi/constants'

const auth = { getTokenSilently: vi.fn(async () => 'token-1') }

const makeReference = (overrides: Partial<ImageGenerationTraceReference> = {}): ImageGenerationTraceReference => {
    return {
        id: 'branch:person',
        imageUrl: 'nats-obj://workspace-workspace-1-files/person-file',
        source: 'branch-candidate',
        label: 'painted portrait of the man',
        role: 'target',
        nodeId: 'person',
        assetId: 'person-asset',
        ...overrides,
    }
}

const makeTrace = (referenceImages: ImageGenerationTraceReference[]): ImageGenerationTrace => {
    return {
        traceVersion: 'image-generation-trace-v1',
        chatModelProvider: 'Anthropic',
        chatModelId: 'claude-sonnet-4-6',
        imageModelProvider: 'Google',
        imageModelId: 'gemini-2.5-flash-image',
        imageSize: '1:1',
        toolPrompt: 'Paint the man.',
        finalPrompt: 'Paint the man.',
        promptWasChanged: false,
        referenceImages,
        excludedReferences: [],
    }
}

type RenderOptions = Parameters<typeof createImageGenerationTraceDetails>[0]

const renderTiles = (referenceImages: ImageGenerationTraceReference[], options: RenderOptions = {}) => {
    const details = createImageGenerationTraceDetails({
        auth,
        ...options,
    })
    details.renderReferenceGrid(makeTrace(referenceImages))
    const tiles = Array.from(details.dom.querySelectorAll('.ai-image-generation-reference')) as HTMLElement[]
    const image = details.dom.querySelector('.ai-image-generation-reference-image') as HTMLImageElement
    const unavailable = details.dom.querySelector('.ai-image-generation-reference-unavailable') as HTMLSpanElement

    return {
        details,
        tiles,
        image,
        unavailable,
    }
}

// =============================================================================
// REFERENCE TILE — LOAD/VISIBILITY CONTRACT
// The tile starts hidden and reveals itself in `onload`. That makes the load
// strategy load-bearing: a hidden image is `display:none`, so `loading="lazy"`
// would never enter the viewport, never load, never fire `onload`, and the
// thumbnail would stay blank forever. These tests pin that contract.
// =============================================================================

describe('createImageGenerationTraceDetails — reference tile load contract', () => {
    it('never marks the reference image loading="lazy" (a hidden lazy image never loads)', () => {
        const { image } = renderTiles([makeReference()])
        expect(image.getAttribute('loading')).not.toBe('lazy')
    })

    it('starts the image and the unavailable hint hidden', () => {
        const {
            image,
            unavailable,
        } = renderTiles([makeReference()])
        expect(image.hidden).toBe(true)
        expect(unavailable.hidden).toBe(true)
    })

    it('reveals the image once it loads', () => {
        const {
            tiles,
            image,
            unavailable,
        } = renderTiles([makeReference()])
        image.dispatchEvent(new Event('load'))
        expect(image.hidden).toBe(false)
        expect(unavailable.hidden).toBe(true)
        expect(tiles[0].classList.contains('is-unavailable')).toBe(false)
    })

    it('shows the unavailable hint when every source errors', async () => {
        const {
            tiles,
            image,
            unavailable,
        } = renderTiles([makeReference()])
        await vi.waitFor(() => expect(image.src).not.toBe(''))
        image.dispatchEvent(new Event('error'))
        await vi.waitFor(() => expect(unavailable.hidden).toBe(false))
        expect(image.hidden).toBe(true)
        expect(tiles[0].classList.contains('is-unavailable')).toBe(true)
    })
})

// =============================================================================
// REFERENCE TILE — SOURCE RESOLUTION
// =============================================================================

describe('createImageGenerationTraceDetails — reference source resolution', () => {
    it('treats a nats-obj:// reference as unusable and falls back to the asset rendition path', async () => {
        // resolveReferenceImageSrc drops nats-obj:// URLs entirely (they can't be
        // fetched by the browser), so the asset-backed rendition path is the only
        // usable source here.
        const { image } = renderTiles([makeReference({ imageUrl: 'nats-obj://workspace-workspace-1-files/person-file' })])
        await vi.waitFor(() => expect(image.src).toContain('/api/assets/person-asset/renditions/preview'))
        expect(image.src).toContain('token=token-1')
    })

    it('falls back to the asset rendition path when imageUrl is empty', async () => {
        const { image } = renderTiles([makeReference({ imageUrl: '' })])
        await vi.waitFor(() => expect(image.src).toContain('/api/assets/person-asset/renditions/preview'))
    })

    it('retries the next source (e.g. the canvas in-memory image) when the primary errors', async () => {
        const { image } = renderTiles(
            [makeReference({
                imageUrl: 'http://example.com/primary.png',
                assetId: undefined,
            })],
            { getAdditionalReferenceImageSources: () => ['blob:canvas-fallback'] },
        )
        await vi.waitFor(() => expect(image.src).toContain('http://example.com/primary.png'))
        image.dispatchEvent(new Event('error'))
        await vi.waitFor(() => expect(image.src).toContain('blob:canvas-fallback'))
    })
})

// =============================================================================
// REFERENCE GRID
// =============================================================================

describe('createImageGenerationTraceDetails — reference grid', () => {
    it('renders one tile per reference with the formatted role', () => {
        const { tiles } = renderTiles([
            makeReference({
                id: 'a',
                role: 'target',
            }),
            makeReference({
                id: 'b',
                role: 'style-reference',
                assetId: 'style-asset',
                nodeId: 'style-node',
                imageUrl: 'nats-obj://workspace-workspace-1-files/style-file',
            }),
        ])
        expect(tiles).toHaveLength(2)
        expect(tiles[0].getAttribute('aria-label')).toBe('painted portrait of the man')
        expect(tiles[0].dataset.helpTooltip).toBe('aria-label')
        expect(tiles[0].getAttribute('title')).toBeNull()
        expect(tiles[0].querySelector('.ai-image-generation-reference-role')?.textContent).toBe('Target')
        expect(tiles[1].querySelector('.ai-image-generation-reference-role')?.textContent).toBe('Style Reference')
    })

    it('shows an empty-state message when there are no references', () => {
        const {
            details,
            tiles,
        } = renderTiles([])
        expect(tiles).toHaveLength(0)
        expect(details.dom.querySelector('.ai-image-generation-empty-references')?.textContent).toContain('No reference images were sent')
    })

    it('renders one target tile when one Asset was persisted under duplicate candidate IDs', () => {
        const duplicateBaseContext = makeReference({
            id: 'node-without-prefix',
            role: 'base-context',
            candidateId: 'reference-node',
        })
        const activeTarget = makeReference({
            id: 'node-with-prefix',
            role: 'target',
            candidateId: 'node:reference-node',
        })

        const distinctReferences = deduplicateImageGenerationTraceReferences([
            duplicateBaseContext,
            activeTarget,
        ])
        const { tiles } = renderTiles([duplicateBaseContext, activeTarget])

        expect(distinctReferences).toEqual([activeTarget])
        expect(tiles).toHaveLength(1)
        expect(tiles[0].querySelector('.ai-image-generation-reference-role')?.textContent).toBe('Target')
    })
})

// =============================================================================
// RENDER CONTRACTS
// =============================================================================

describe('createImageGenerationTraceDetails — render contract', () => {
    it('shows tool prompt fallback text only when fallback conditions apply', () => {
        const details = createImageGenerationTraceDetails()

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: true,
                imageGenerationTraceId: 'streaming-trace',
            },
            childCount: 2,
            toolPromptFallbackText: 'draft from server',
        })
        expect(details.dom.querySelector('.ai-image-generation-tool-prompt-fallback')?.textContent).toBe('')
        expect(details.dom.querySelector('.ai-image-generation-tool-prompt-fallback')?.hidden).toBe(true)

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: true,
                imageGenerationTraceId: 'streaming-trace',
            },
            childCount: 0,
            toolPromptFallbackText: 'draft from server',
        })
        expect(details.dom.querySelector('.ai-image-generation-tool-prompt-fallback')?.textContent).toBe('draft from server')
        expect(details.dom.querySelector('.ai-image-generation-tool-prompt-fallback')?.hidden).toBe(false)

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: true,
                imageGenerationTraceId: 'streaming-trace',
            },
            childCount: 0,
            toolPromptFallbackText: 'draft from server',
            forceToolPromptFallback: true,
        })
        expect(details.dom.querySelector('.ai-image-generation-tool-prompt-fallback')?.textContent).toBe('draft from server')
        expect(details.dom.querySelector('.ai-image-generation-tool-prompt-fallback')?.hidden).toBe(false)
    })

    it('shows final prompt only when the prompt was changed in resolver mode', () => {
        const details = createImageGenerationTraceDetails()
        const baselineTrace = makeTrace([makeReference()])
        const changedTrace: ImageGenerationTrace = {
            ...baselineTrace,
            promptWasChanged: true,
            finalPrompt: 'Adjusted prompt with stronger style constraints',
        }
        const finalPrompt = details.dom.querySelector('.ai-image-generation-final-prompt') as HTMLElement
        const finalPromptSection = details.dom.querySelector('.ai-image-generation-final-prompt-section') as HTMLElement

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: false,
                imageGenerationTrace: baselineTrace,
            },
            childCount: 1,
        })
        expect(finalPromptSection.hidden).toBe(true)

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: false,
                imageGenerationTrace: changedTrace,
            },
            childCount: 1,
        })
        expect(finalPromptSection.hidden).toBe(false)
        expect(finalPrompt.textContent).toBe('Adjusted prompt with stronger style constraints')
    })

    it('updates streaming/trace wrapper classes from attrs and hides trace sections when no trace exists', () => {
        const details = createImageGenerationTraceDetails()
        const referenceSection = details.dom.querySelector('.ai-image-generation-reference-section') as HTMLElement
        const resolverSection = details.dom.querySelector('.ai-image-generation-resolver-section') as HTMLElement
        const resolverSummary = details.dom.querySelector('.ai-image-generation-resolver-summary') as HTMLElement

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: false,
                imageGenerationTraceId: null,
            },
            childCount: 0,
        })
        expect(details.dom.classList.contains('has-image-generation-trace')).toBe(false)
        expect(details.dom.classList.contains('is-streaming')).toBe(false)
        expect(referenceSection.hidden).toBe(true)
        expect(resolverSection.hidden).toBe(true)
        expect(resolverSummary.textContent).toBe('')

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: true,
                imageGenerationTrace: makeTrace([makeReference()]),
            },
            childCount: 1,
        })
        expect(details.dom.classList.contains('has-image-generation-trace')).toBe(true)
        expect(details.dom.classList.contains('is-streaming')).toBe(true)
        expect(referenceSection.hidden).toBe(false)
    })

    it('renders resolver details and excluded-reference list independently', () => {
        const details = createImageGenerationTraceDetails()
        const traceWithResolver: ImageGenerationTrace = {
            ...makeTrace([makeReference()]),
            resolver: {
                resolverKind: 'structured-vlm',
                resolverVersion: 'v1',
                resolverModelProvider: 'Anthropic',
                resolverModelId: 'claude-sonnet-4-6',
                mode: 'context-only',
                operationKind: 'new_image',
                confidence: 0.82,
                rationale: 'Closest candidate in context',
                targetCandidateId: 'person',
                branchId: null,
            },
            excludedReferences: [
                {
                    candidateId: 'excluded-node',
                    nodeId: 'excluded-node',
                    label: 'Old result',
                    role: 'excluded',
                    reason: 'Low similarity',
                },
            ],
        }

        details.render({
            attrs: {
                title: 'Image generation prompt',
                isOpen: false,
                isStreaming: false,
                imageGenerationTrace: traceWithResolver,
            },
            childCount: 1,
        })

        const resolverSection = details.dom.querySelector('.ai-image-generation-resolver-section') as HTMLElement
        const resolverSummary = details.dom.querySelector('.ai-image-generation-resolver-summary') as HTMLElement
        const resolverRationale = details.dom.querySelector('.ai-image-generation-resolver-rationale') as HTMLElement
        const excludedList = details.dom.querySelector('.ai-image-generation-excluded-list') as HTMLElement

        expect(resolverSection.hidden).toBe(false)
        expect(resolverSummary.textContent).toBe('New Image | Context Only | confidence 82%')
        expect(resolverRationale.textContent).toBe('Closest candidate in context')
        expect(excludedList.hidden).toBe(false)
        expect(excludedList.children).toHaveLength(1)
    })

    it('renders Capability execution metadata and workflow steps without media-only sections', () => {
        const details = createImageGenerationTraceDetails()
        const capabilityGenerationTrace: CapabilityGenerationTrace = {
            traceVersion: 'capability-generation-trace-v1',
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
            steps: [{
                stepId: 'persist',
                title: 'Persist timeline',
                status: 'completed',
                outputSummary: 'Timeline persisted',
            }],
        }

        details.render({
            attrs: {
                title: 'Action Timeline generation details',
                isOpen: false,
                isStreaming: false,
                capabilityGenerationTrace,
            },
            childCount: 0,
        })

        const capabilitySection = details.dom.querySelector('.ai-capability-generation-details-section') as HTMLElement
        const toolPromptSection = details.dom.querySelector('.ai-image-generation-tool-prompt-section') as HTMLElement
        const metadataText = details.dom.querySelector('.ai-capability-generation-metadata')?.textContent ?? ''
        const step = details.dom.querySelector('.ai-capability-generation-step') as HTMLElement

        expect(details.dom.classList.contains('has-capability-generation-trace')).toBe(true)
        expect(capabilitySection.hidden).toBe(false)
        expect(toolPromptSection.hidden).toBe(true)
        expect(metadataText).toContain('Action Timeline')
        expect(metadataText).toContain('Anthropic:claude-haiku-4-5')
        expect(metadataText).toContain('timeline-run')
        expect(step.textContent).toContain('Persist timeline')
        expect(step.textContent).toContain('Completed')
        expect(step.textContent).toContain('Timeline persisted')
    })
})

describe('formatTraceModelLabel', () => {
    it('returns the model segment of a Provider:model id', () => void expect(formatTraceModelLabel('Anthropic:claude-sonnet-4-6')).toBe('claude-sonnet-4-6'))

    it('returns an empty string for a missing id', () => {
        expect(formatTraceModelLabel('')).toBe('')
        expect(formatTraceModelLabel(undefined)).toBe('')
        expect(formatTraceModelLabel(null)).toBe('')
    })
})

describe('formatImageGenerationTraceRole', () => {
    it('formats role strings into displayable labels', () => {
        expect(formatImageGenerationTraceRole('target')).toBe('Target')
        expect(formatImageGenerationTraceRole('style-reference')).toBe('Style Reference')
        expect(formatImageGenerationTraceRole('context-only')).toBe('Context Only')
        expect(formatImageGenerationTraceRole('')).toBe('')
    })
})

describe('formatImageGenerationTraceReferenceSource', () => {
    it('maps known reference sources to stable human labels', () => {
        expect(formatImageGenerationTraceReferenceSource('branch-candidate')).toBe('Image from this branch')
        expect(formatImageGenerationTraceReferenceSource('message-reference')).toBe('Attached to chat message')
        expect(formatImageGenerationTraceReferenceSource('unknown-source')).toBe('Reference image')
    })
})

describe('trace cache and fallback helpers', () => {
    it('prefers cache lookups when imageGenerationTraceId is provided', () => {
        const cachedTrace = makeTrace([makeReference({
            id: 'cached',
            label: 'Cached trace image',
        })])
        const inlineTrace = makeTrace([makeReference({
            id: 'inline',
            label: 'Inline trace image',
        })])
        cacheImageGenerationTrace('trace-1', cachedTrace)

        const resolved = getImageGenerationTrace({
            title: 'Image generation prompt',
            isOpen: false,
            isStreaming: false,
            imageGenerationTraceId: 'trace-1',
            imageGenerationTrace: inlineTrace,
        })

        expect(resolved).toBe(cachedTrace)
        expect((resolved?.referenceImages[0] as ImageGenerationTraceReference).label).toBe('Cached trace image')
    })

    it('falls back to inline trace when no trace ID is supplied', () => {
        const inlineTrace = makeTrace([makeReference({
            id: 'inline',
            label: 'Inline trace image',
        })])

        const resolved = getImageGenerationTrace({
            title: 'Image generation prompt',
            isOpen: false,
            isStreaming: false,
            imageGenerationTrace: inlineTrace,
        })

        expect(resolved).toBe(inlineTrace)
    })

    it('returns null when cached trace id is missing and no inline trace exists', () => {
        const resolved = getImageGenerationTrace({
            title: 'Image generation prompt',
            isOpen: false,
            isStreaming: false,
            imageGenerationTraceId: 'missing',
        })
        expect(resolved).toBeNull()
    })
})
