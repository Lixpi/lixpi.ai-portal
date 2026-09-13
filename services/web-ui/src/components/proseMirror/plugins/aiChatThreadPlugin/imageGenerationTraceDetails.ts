import {
    type CapabilityGenerationTrace,
    type ImageGenerationTrace,
    type ImageGenerationTraceExcludedReference,
    type ImageGenerationTraceReference,
    type VideoGenerationTrace,
} from '@lixpi/constants'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'

import { html } from '@lixpi/ui-primitives/dom'
import { resolveAuthenticatedMediaUrl } from '$src/utils/mediaUrls.ts'

// Image and video generation traces share an identical reference/excluded/
// resolver/prompt shape, so this renderer is reused verbatim for both media
// kinds. The video trace carries the extra aspectRatio/resolution/durationSeconds
// fields, which this renderer ignores.
export type GenerationTrace = ImageGenerationTrace | VideoGenerationTrace

export type ImageGenerationTraceDetailsAttrs = {
    title: string
    isOpen: boolean
    isStreaming: boolean
    imageGenerationTrace?: ImageGenerationTrace | null
    imageGenerationTraceId?: string | null
    videoGenerationTrace?: VideoGenerationTrace | null
    capabilityGenerationTrace?: CapabilityGenerationTrace | null
    reasoningModelId?: string | null
}

type RenderImageGenerationTraceDetailsParams = {
    attrs: ImageGenerationTraceDetailsAttrs
    childCount: number
    forceToolPromptFallback?: boolean
    toolPromptFallbackText?: string
}

export type ImageGenerationTraceDetailsOptions = {
    auth?: AuthTokenProvider
    className?: string
    hideToolPrompt?: boolean
    getAdditionalReferenceImageSources?: (reference: ImageGenerationTraceReference) => string[]
    // Lets the host render its own reference tile (e.g. the canvas context-preview
    // tile: thumbnail-only with a rich hover card). When it returns an element that
    // element replaces the default captioned tile; returning null falls back.
    renderReferenceTile?: (reference: ImageGenerationTraceReference) => HTMLElement | null
}

export type ImageGenerationTraceDetails = {
    dom: HTMLElement
    contentDom: HTMLElement
    render: (params: RenderImageGenerationTraceDetailsParams) => void
    renderReferenceGrid: (trace: GenerationTrace) => void
}

const imageGenerationTraceCache = new Map<string, ImageGenerationTrace>()

export const cacheImageGenerationTrace = (
    traceId: string,
    trace: ImageGenerationTrace,
): void => void imageGenerationTraceCache.set(traceId, trace)

export const getImageGenerationTrace = (attrs: ImageGenerationTraceDetailsAttrs): GenerationTrace | null => {
    if (attrs.imageGenerationTraceId)
        return imageGenerationTraceCache.get(attrs.imageGenerationTraceId) ?? null

    return attrs.imageGenerationTrace ?? attrs.videoGenerationTrace ?? null
}

export const formatImageGenerationTraceRole = (role: string): string =>
    role
        .split(/[-_]/).map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(' ')

// Human-readable provenance for a reference image. The raw `label` is the prompt
// that produced the source image, which reads like a stray user prompt — so the
// caption names where the image actually came from instead.
export const formatImageGenerationTraceReferenceSource = (source: string): string => {
    switch (source) {
        case 'branch-candidate':
            return 'Image from this branch'
        case 'message-reference':
            return 'Attached to chat message'
        default:
            return 'Reference image'
    }
}

export const formatTraceModelLabel = (modelId?: string | null): string => {
    if (!modelId)
        return ''

    const parts = String(modelId).split(':')

    return parts[1] || parts[0] || ''
}

const getReferenceWorkspaceImagePath = (reference: ImageGenerationTraceReference): string | null => {
    if (reference.assetId)
        return `/api/assets/${encodeURIComponent(reference.assetId)}/renditions/preview`

    return null
}

const uniqueImageSources = (sources: string[]): string[] => {
    const seen = new Set<string>()

    return sources.filter(source => {
        if (
            !source
            || seen.has(source)
        )
            return false

        seen.add(source)

        return true
    })
}

const getReferenceIdentity = (reference: ImageGenerationTraceReference): string => {
    if (reference.assetId)
        return `asset:${reference.assetId}`

    if (reference.nodeId)
        return `node:${reference.nodeId}`

    if (reference.imageUrl)
        return `image:${reference.imageUrl}`

    return `reference:${reference.id}`
}

const getReferenceRolePriority = (reference: ImageGenerationTraceReference): number => {
    switch (reference.role) {
        case 'target':
            return 5
        case 'comparison-target':
            return 4
        case 'message-reference':
            return 3
        case 'capability-reference':
            return 2
        default:
            return 1
    }
}

// Historical traces may contain the same Asset twice when browser branch
// context and workspace context assigned different candidate IDs. Rendering is
// Asset-identity based and keeps the strongest role at the original position.
export const deduplicateImageGenerationTraceReferences = (references: ImageGenerationTraceReference[]): ImageGenerationTraceReference[] => {
    const distinctReferences: ImageGenerationTraceReference[] = []
    const referenceIndexByIdentity = new Map<string, number>()

    for (const reference of references) {
        const identity = getReferenceIdentity(reference)
        const existingIndex = referenceIndexByIdentity.get(identity)

        if (existingIndex === undefined) {
            referenceIndexByIdentity.set(identity, distinctReferences.length)
            distinctReferences.push(reference)

            continue
        }

        if (getReferenceRolePriority(reference) > getReferenceRolePriority(distinctReferences[existingIndex]!))
            distinctReferences[existingIndex] = reference
    }

    return distinctReferences
}

const getReferenceImageSources = (
    reference: ImageGenerationTraceReference,
    options: ImageGenerationTraceDetailsOptions,
): string[] => {
    return uniqueImageSources([
        (reference.imageUrl ?? '').trim(),
        getReferenceWorkspaceImagePath(reference) ?? '',
        ...(options.getAdditionalReferenceImageSources?.(reference) ?? []),
    ])
}

const resolveReferenceImageSrc = async (
    imageUrl: string,
    options: ImageGenerationTraceDetailsOptions,
): Promise<string> => {
    const source = imageUrl.startsWith('nats-obj://') ? '' : imageUrl

    return resolveAuthenticatedMediaUrl(
        source,
        {
            apiBaseUrl: import.meta.env.VITE_API_URL || '',
            getAuthToken: () => options.auth?.getTokenSilently() ?? Promise.resolve(false),
        },
    )
}

const resolveReferenceImageSources = async (
    reference: ImageGenerationTraceReference,
    options: ImageGenerationTraceDetailsOptions,
): Promise<string[]> => {
    const resolvedSources: string[] = []

    for (const source of getReferenceImageSources(reference, options)) {
        const resolvedSource = await resolveReferenceImageSrc(source, options)

        if (resolvedSource)
            resolvedSources.push(resolvedSource)
    }

    return uniqueImageSources(resolvedSources)
}

const createReferenceTile = (
    reference: ImageGenerationTraceReference,
    options: ImageGenerationTraceDetailsOptions,
): HTMLElement => {
    const role = formatImageGenerationTraceRole(reference.role)
    const sourceLabel = formatImageGenerationTraceReferenceSource(reference.source)
    // The tile starts hidden and reveals itself in `onload` (so the multi-source
    // retry chain never flashes a broken image). `loading="lazy"` must NOT be used
    // here: a hidden image is `display:none`, never intersects the viewport, so a
    // lazy image would never load — `onload` would never fire and the tile would
    // stay blank. Eager loading loads regardless of visibility.
    const image = html`
        <img
            className="ai-image-generation-reference-image"
            alt=${reference.label}
        />
    ` as HTMLImageElement
    const unavailable = html`<span className="ai-image-generation-reference-unavailable">Unavailable</span>` as HTMLSpanElement
    const tile = html`
        <figure
            className="ai-image-generation-reference"
            aria-label=${reference.label}
            data=${{
                helpTooltip: 'aria-label',
                source: reference.source,
                role: reference.role,
            }}
        >
            <div className="ai-image-generation-reference-thumb">
                ${image}
                ${unavailable}
            </div>
            <figcaption>
                <span className="ai-image-generation-reference-label">${sourceLabel}</span>
                <span className="ai-image-generation-reference-role">${role}</span>
            </figcaption>
        </figure>
    ` as HTMLElement

    image.hidden = true
    unavailable.hidden = true
    let sourceIndex = 0
    let resolvedSourcesPromise: Promise<string[]> | null = null

    const getResolvedSources = (): Promise<string[]> => {
        resolvedSourcesPromise ??= resolveReferenceImageSources(reference, options)

        return resolvedSourcesPromise
    }

    const showUnavailable = () => {
        image.hidden = true
        unavailable.hidden = false
        tile.classList.add('is-unavailable')
    }

    image.onload = () => {
        image.hidden = false
        unavailable.hidden = true
        tile.classList.remove('is-unavailable')
    }
    image.onerror = async () => {
        const retryNextSource = async () => {
            sourceIndex += 1
            const sources = await getResolvedSources()
            const nextSource = sources[sourceIndex]

            if (nextSource) {
                image.src = nextSource

                return
            }

            showUnavailable()
        }

        try {
            await retryNextSource()
        } catch {
            showUnavailable()
        }
    }
    const loadImage = async () => {
        try {
            const sources = await getResolvedSources()
            const src = sources[sourceIndex]

            if (!src) {
                showUnavailable()

                return
            }

            image.src = src
        } catch {
            showUnavailable()
        }
    }

    const resetImage = () => {
        sourceIndex = 0
        image.hidden = true
        unavailable.hidden = true
        tile.classList.remove('is-unavailable')
    }

    resetImage()
    void loadImage()

    return tile
}

const createExcludedItem = (reference: ImageGenerationTraceExcludedReference): HTMLElement => {
    return html`
        <li className="ai-image-generation-excluded-reference">
            <span className="ai-image-generation-excluded-label">${reference.label}</span>
            <span className="ai-image-generation-excluded-node">${reference.nodeId}</span>
            <span className="ai-image-generation-excluded-reason">${reference.reason}</span>
        </li>
    ` as HTMLElement
}

export const createImageGenerationTraceDetails = (options: ImageGenerationTraceDetailsOptions = {}): ImageGenerationTraceDetails => {
    const className = ['ai-generation-trace-block', options.className].filter(Boolean).join(' ')
    const wrapper = html`
        <div className=${className}>
            <div className="ai-generation-trace-body">
                <section className="ai-image-generation-tool-prompt-section">
                    <div className="ai-image-generation-section-label">Prompt for media generation model written by reasoning model</div>
                    <div className="ai-generation-trace-content"></div>
                    <pre className="ai-image-generation-tool-prompt-fallback"></pre>
                </section>
                <section className="ai-image-generation-final-prompt-section">
                    <div className="ai-image-generation-section-label">Final prompt sent to the media generation model</div>
                    <pre className="ai-image-generation-final-prompt"></pre>
                </section>
                <section className="ai-image-generation-reference-section">
                    <div className="ai-image-generation-section-label">Reference items sent to the media generation model</div>
                    <div className="ai-image-generation-reference-grid"></div>
                </section>
                <section className="ai-image-generation-resolver-section">
                    <div className="ai-image-generation-section-label">Resolver audit</div>
                    <div className="ai-image-generation-resolver-summary"></div>
                    <div className="ai-image-generation-resolver-rationale"></div>
                    <ul className="ai-image-generation-excluded-list"></ul>
                </section>
                <section className="ai-capability-generation-details-section">
                    <div className="ai-image-generation-section-label">Capability execution</div>
                    <dl className="ai-capability-generation-metadata"></dl>
                    <div className="ai-image-generation-section-label">Execution steps</div>
                    <ol className="ai-capability-generation-steps"></ol>
                </section>
                <section className="ai-capability-media-review-section">
                    <div className="ai-image-generation-section-label">Capability media comparison</div>
                    <p className="ai-capability-media-review-summary"></p>
                    <ol className="ai-capability-media-review-steps"></ol>
                    <p className="ai-capability-media-review-recommendation"></p>
                </section>
            </div>
        </div>
    ` as HTMLElement

    const contentDom = wrapper.querySelector('.ai-generation-trace-content') as HTMLElement
    const toolPromptSection = wrapper.querySelector('.ai-image-generation-tool-prompt-section') as HTMLElement
    const toolPromptFallback = wrapper.querySelector('.ai-image-generation-tool-prompt-fallback') as HTMLElement
    const finalPromptSection = wrapper.querySelector('.ai-image-generation-final-prompt-section') as HTMLElement
    const finalPrompt = wrapper.querySelector('.ai-image-generation-final-prompt') as HTMLElement
    const referenceSection = wrapper.querySelector('.ai-image-generation-reference-section') as HTMLElement
    const referenceGrid = wrapper.querySelector('.ai-image-generation-reference-grid') as HTMLElement
    const resolverSection = wrapper.querySelector('.ai-image-generation-resolver-section') as HTMLElement
    const resolverSummary = wrapper.querySelector('.ai-image-generation-resolver-summary') as HTMLElement
    const resolverRationale = wrapper.querySelector('.ai-image-generation-resolver-rationale') as HTMLElement
    const excludedList = wrapper.querySelector('.ai-image-generation-excluded-list') as HTMLElement
    const capabilitySection = wrapper.querySelector('.ai-capability-generation-details-section') as HTMLElement
    const capabilityMetadata = wrapper.querySelector('.ai-capability-generation-metadata') as HTMLElement
    const capabilitySteps = wrapper.querySelector('.ai-capability-generation-steps') as HTMLElement
    const capabilityReviewSection = wrapper.querySelector('.ai-capability-media-review-section') as HTMLElement
    const capabilityReviewSummary = wrapper.querySelector('.ai-capability-media-review-summary') as HTMLElement
    const capabilityReviewSteps = wrapper.querySelector('.ai-capability-media-review-steps') as HTMLElement
    const capabilityReviewRecommendation = wrapper.querySelector('.ai-capability-media-review-recommendation') as HTMLElement

    let renderedSignature = ''
    let renderedTrace: GenerationTrace | null = null
    let renderedReferenceTrace: GenerationTrace | null = null

    const renderReferenceGrid = (trace: GenerationTrace) => {
        if (renderedReferenceTrace === trace)
            return

        const referenceImages = deduplicateImageGenerationTraceReferences(trace.referenceImages)

        if (referenceImages.length > 0)
            referenceGrid.replaceChildren(
                ...referenceImages.map(reference => options.renderReferenceTile?.(reference) ?? createReferenceTile(reference, options)),
            )
        else
            referenceGrid.replaceChildren(html`<div className="ai-image-generation-empty-references">No reference images were sent.</div>`)

        renderedReferenceTrace = trace
    }

    const render = ({
        attrs,
        childCount,
        forceToolPromptFallback = false,
        toolPromptFallbackText,
    }: RenderImageGenerationTraceDetailsParams) => {
        const trace = getImageGenerationTrace(attrs)
        const capabilityReview = trace?.traceVersion === 'image-generation-trace-v1'
            ? trace.capabilityReview
            : undefined
        const capabilityTrace = attrs.capabilityGenerationTrace ?? null
        const hasTrace = Boolean(trace)
        const fallbackText = toolPromptFallbackText
            ?? trace?.toolPrompt
            ?? ''
        const signature = [
            attrs.title,
            attrs.isStreaming ? 'streaming' : 'done',
            childCount,
            attrs.reasoningModelId ?? '',
            attrs.imageGenerationTraceId ?? 'inline-trace',
            forceToolPromptFallback ? 'force-fallback' : 'content-fallback',
            fallbackText,
            capabilityTrace?.capabilityRunId ?? '',
            capabilityReview?.summary ?? '',
        ].join('|')

        if (
            signature === renderedSignature
            && trace === renderedTrace
        ) {
            if (trace)
                renderReferenceGrid(trace)

            return
        }

        renderedSignature = signature
        renderedTrace = trace

        wrapper.classList.toggle('has-image-generation-trace', hasTrace)
        wrapper.classList.toggle(
            'has-capability-generation-trace',
            Boolean(capabilityTrace),
        )
        wrapper.classList.toggle(
            'has-capability-media-review',
            Boolean(capabilityReview),
        )
        wrapper.classList.toggle('is-streaming', attrs.isStreaming)

        capabilitySection.hidden = !capabilityTrace

        if (capabilityTrace) {
            const metadata = [
                ['Capability', capabilityTrace.capabilityName],
                ['Reasoning model', capabilityTrace.chatModelId],
                ['Tool run', capabilityTrace.capabilityRunId],
                ['Output Assets', String(capabilityTrace.outputAssetIds.length)],
            ]
            capabilityMetadata.replaceChildren(...metadata.flatMap(
                ([label, value]) => [
                    html`<dt>${label}</dt>`,
                    html`<dd>${value}</dd>`,
                ],
            ))
            capabilitySteps.replaceChildren(
                ...capabilityTrace.steps.map(
                    step =>
                        html`
                            <li
                                className="ai-capability-generation-step"
                                data=${{ status: step.status }}
                            >
                                <span className="ai-capability-generation-step-title">${step.title}</span>
                                <span className="ai-capability-generation-step-status">${formatImageGenerationTraceRole(step.status)}</span>
                                ${step.outputSummary ? html`<span className="ai-capability-generation-step-summary">${step.outputSummary}</span>` : null}
                                ${step.errorMessage ? html`<span className="ai-capability-generation-step-error">${step.errorMessage}</span>` : null}
                            </li>
                        `,
                ),
            )
        } else {
            capabilityMetadata.replaceChildren()
            capabilitySteps.replaceChildren()
        }

        capabilityReviewSection.hidden = !capabilityReview

        if (capabilityReview) {
            capabilityReviewSummary.textContent = `${capabilityReview.summary} Automatic retries: ${capabilityReview.automaticRetries}.`
            capabilityReviewSteps.replaceChildren(
                ...capabilityReview.steps.map(
                    step =>
                        html`
                            <li
                                className="ai-capability-media-review-step"
                                data=${{ status: step.status }}
                            >
                                <span className="ai-capability-media-review-step-title">${step.title}</span>
                                <span className="ai-capability-media-review-step-status">
                                    ${formatImageGenerationTraceRole(step.status)}${step.score === undefined ? '' : ` · ${Math.round(step.score * 100)}%`}
                                </span>
                                ${
                                    step.issues.length > 0
                                        ? html`<span className="ai-capability-media-review-step-issues">${step.issues.join(', ')}</span>`
                                        : null
                                }
                            </li>
                        `,
                ),
            )
            capabilityReviewRecommendation.textContent = capabilityReview.recommendation ?? ''
        } else {
            capabilityReviewSummary.textContent = ''
            capabilityReviewSteps.replaceChildren()
            capabilityReviewRecommendation.textContent = ''
        }

        const shouldShowFallback = Boolean(fallbackText && (forceToolPromptFallback || childCount === 0))
        toolPromptSection.hidden = Boolean(capabilityTrace) || Boolean(options.hideToolPrompt)
        toolPromptSection.classList.toggle('has-content', hasTrace || childCount > 0 || shouldShowFallback)
        toolPromptFallback.textContent = shouldShowFallback ? fallbackText : ''
        toolPromptFallback.hidden = !shouldShowFallback

        const shouldShowFinalPrompt = Boolean(trace?.promptWasChanged && trace.finalPrompt.trim())
        finalPromptSection.hidden = !shouldShowFinalPrompt
        finalPrompt.textContent = shouldShowFinalPrompt ? trace!.finalPrompt : ''

        referenceSection.hidden = !hasTrace

        if (!trace) {
            referenceGrid.replaceChildren()
            renderedReferenceTrace = null
        } else
            renderReferenceGrid(trace)

        const resolver = trace?.resolver
        const hasExcluded = Boolean(trace?.excludedReferences.length)
        resolverSection.hidden = !resolver && !hasExcluded
        resolverSummary.textContent = resolver
            ? `${formatImageGenerationTraceRole(resolver.operationKind)} | ${formatImageGenerationTraceRole(resolver.mode)} | confidence ${Math.round(
                resolver.confidence * 100,
            )}%`
            : ''
        resolverRationale.textContent = resolver?.rationale ?? ''
        excludedList.replaceChildren(...(trace?.excludedReferences ?? []).map(createExcludedItem))
        excludedList.hidden = !hasExcluded
    }

    return {
        dom: wrapper,
        contentDom,
        render,
        renderReferenceGrid,
    }
}
