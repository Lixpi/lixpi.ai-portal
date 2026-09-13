import {
    brokenImageIcon,
    videoControlIcons,
} from '@lixpi/ui-kit/svg'
import {
    html,
    applyStyle,
} from '@lixpi/ui-primitives/dom'
import {
    buildAssetRenditionPath,
    resolveAuthenticatedMediaUrl,
} from '$src/utils/mediaUrls.ts'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import { settings } from '$src/settings.ts'
import { NodeSelection } from 'prosemirror-state'
// @ts-ignore - runtime import
import { select } from 'd3-selection'
import {
    applyVideoControlsHostStyleProperties,
    createVideoControls,
    type VideoControlsInstance,
} from '@lixpi/ui-kit/components/video-controls'
import { renderMediaModelBadge } from '@lixpi/ui-kit/components/media-model-badge'
import {
    applyMediaModelBadgeStyleProperties,
    resolveMediaModelBadgeConfig,
} from '$src/components/mediaModelBadge/mediaModelBadge.ts'
import { aiModelsStore } from '$src/stores/aiModelsStore.ts'
import {
    aiGeneratedVideoNodeSpec,
    aiGeneratedVideoNodeType,
} from '@lixpi/prosemirror'

// Sibling of aiGeneratedImageNode.ts. The in-chat representation of a generated
// video. While VIDEO_PENDING is the active state, the node renders a placeholder
// (matching the canvas placeholder style — no DOM spinner per PR #202). On
// VIDEO_COMPLETE the node swaps to a poster + controls-less <video> element,
// then mounts the shared SVG videoControls bar as an external row below it.

export {
    aiGeneratedVideoNodeSpec,
    aiGeneratedVideoNodeType,
}

const buildAuthenticatedUrl = async (
    auth: AuthTokenProvider | undefined,
    url: string,
): Promise<string> => {
    return resolveAuthenticatedMediaUrl(
        url,
        {
            apiBaseUrl: import.meta.env.VITE_API_URL || '',
            getAuthToken: () => auth?.getTokenSilently() ?? Promise.resolve(false),
        },
    )
}

export const aiGeneratedVideoNodeView = (
    node: any,
    view: any,
    getPos: () => number | undefined,
    auth?: AuthTokenProvider,
) => {
    const normalizeScale = (value: number): number => Number.isFinite(
        Number(value),
    )
        && Number(value) > 0
        ? Number(value)
        : 1
    const controlsScale = normalizeScale(settings.videoControls.chat.controlsScale)
    const controlsSvgHeight = settings.videoControls.height
    const controlsHeight = controlsSvgHeight * controlsScale
    const controlsStyles = settings.videoControls.styles
    const containerStyle = {
        position: 'relative' as const,
        overflow: 'hidden' as const,
        aspectRatio: String(Number(node.attrs.aspectRatio) || 1.777),
    }
    const controlsHostStyle = {
        height: `${controlsHeight}px`,
        margin: `${settings.videoControls.chat.bottomInset}px ${settings.videoControls.chat.horizontalInset}px 0`,
        pointerEvents: 'auto' as const,
        borderRadius: controlsStyles.hostBorderRadius,
        filter: controlsStyles.hostDropShadow,
        backdropFilter: controlsStyles.hostBackdropFilter,
        webkitBackdropFilter: controlsStyles.hostBackdropFilter,
        overflow: 'hidden' as const,
        display: 'none',
    }
    const wrapper = html`
        <div className="ai-generated-video-wrapper ai-generated-media-node">
            <div className="ai-generated-media-section-title">Final generated video</div>
            <div
                className="ai-generated-video-container"
                style=${containerStyle}
            >
                <div className="ai-generated-video-placeholder">
                    <span className="placeholder-text">Generating video…</span>
                </div>
                <video
                    className="ai-generated-video-content"
                    preload="metadata"
                    playsinline
                    crossorigin="anonymous"
                ></video>
            </div>
            <div
                className="ai-generated-video-controls-host nopan"
                style=${controlsHostStyle}
            ></div>
            <div className="ai-generated-media-model-chrome ai-generated-media-run-meta"></div>
        </div>
    `

    const container = wrapper.querySelector('.ai-generated-video-container') as HTMLElement
    const titleElement = wrapper.querySelector('.ai-generated-media-section-title') as HTMLElement
    const placeholderElement = wrapper.querySelector('.ai-generated-video-placeholder') as HTMLElement
    const placeholderText = wrapper.querySelector('.ai-generated-video-placeholder .placeholder-text') as HTMLElement
    const videoElement = wrapper.querySelector('.ai-generated-video-content') as HTMLVideoElement
    const controlsHost = wrapper.querySelector('.ai-generated-video-controls-host') as HTMLDivElement
    const modelChromeElement = wrapper.querySelector('.ai-generated-media-model-chrome') as HTMLElement
    applyVideoControlsHostStyleProperties(controlsHost, settings.videoControls.styles)
    applyMediaModelBadgeStyleProperties(wrapper, { scale: settings.mediaNode.generatedMediaChrome.chatScale })
    let videoControls: VideoControlsInstance | null = null
    let controlsSvg: any = null
    let resizeObserver: ResizeObserver | null = null
    let unsubscribeAiModelsStore: (() => void) | null = null

    titleElement.hidden = true
    applyStyle(videoElement, { display: 'none' })

    const syncContainerGeometry = (): void => {
        applyStyle(
            container,
            {
                aspectRatio: String(Number(node.attrs.aspectRatio) || 1.777),
            },
        )
    }

    const handleClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement

        if (
            target.closest('.ai-generated-video-controls-host')
            || target.tagName === 'VIDEO'
        )
            return

        event.preventDefault()
        event.stopPropagation()

        if (!view.editable)
            return

        const pos = getPos()

        if (pos === undefined)
            return

        const tr = view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, pos),
        )
        view.dispatch(tr)
        view.focus()
    }

    wrapper.addEventListener('click', handleClick)

    const updateModelChrome = (): void => {
        renderMediaModelBadge(
            modelChromeElement,
            resolveMediaModelBadgeConfig({
                modelId: node.attrs.mediaModelId || node.attrs.videoModel,
            }),
        )
    }

    const clearErrorPlaceholder = (): void => void container.querySelector('.video-error-placeholder')?.remove()

    const getControlsWidth = (): number => Math.max(settings.videoControls.chat.minWidth / controlsScale, getControlsVisualWidth() / controlsScale)

    const getControlsVisualWidth = (): number => {
        const measuredWidth = controlsHost.getBoundingClientRect().width || controlsHost.clientWidth

        return Math.max(settings.videoControls.chat.minWidth, measuredWidth || settings.videoControls.chat.fallbackWidth)
    }

    const syncControlsGeometry = (): void => {
        if (
            !videoControls
            || !controlsSvg
        )
            return

        const width = getControlsWidth()
        controlsSvg
            .attr('viewBox', `0 0 ${width} ${controlsSvgHeight}`)
            .attr('width', `${100 / controlsScale}%`)
            .attr(
                'height',
                String(controlsSvgHeight),
            )
        videoControls.resize(
            0,
            0,
            width,
            getControlsVisualWidth(),
        )
    }

    const destroyVideoControls = (): void => {
        videoControls?.destroy()
        videoControls = null
        controlsSvg = null
        controlsHost.replaceChildren()
    }

    const ensureVideoControls = (): void => {
        if (videoControls) {
            syncControlsGeometry()

            return
        }

        const width = getControlsWidth()
        controlsSvg = select(controlsHost)
            .append('svg')
            .attr('class', 'ai-generated-video-controls-svg')
            .attr('width', `${100 / controlsScale}%`)
            .attr(
                'height',
                String(controlsSvgHeight),
            )
            .attr('viewBox', `0 0 ${width} ${controlsSvgHeight}`)
            .style('display', 'block')
            .style('overflow', 'visible')
            .style('pointer-events', 'none')
            .style('transform-origin', '0 0')
            .style('transform', `scale(${controlsScale})`)

        videoControls = createVideoControls(
            controlsSvg,
            {
                icons: videoControlIcons,
                settings: settings.videoControls,
                id: String(node.attrs.responseId || node.attrs.assetId || 'chat-video'),
                x: 0,
                y: 0,
                width,
                height: controlsSvgHeight,
                responsiveWidth: getControlsVisualWidth(),
                videoEl: videoElement,
                className: 'ai-generated-video-controls',
            },
        )

        if (
            !resizeObserver
            && typeof ResizeObserver !== 'undefined'
        ) {
            resizeObserver = new ResizeObserver(syncControlsGeometry)
            resizeObserver.observe(controlsHost)
        }
    }

    const updateDisplay = async () => {
        const {
            videoUrl,
            posterUrl,
            assetId,
            isPending,
            errorMessage,
        } = node.attrs

        if (errorMessage) {
            titleElement.hidden = true
            clearErrorPlaceholder()
            applyStyle(videoElement, { display: 'none' })
            applyStyle(controlsHost, { display: 'none' })
            destroyVideoControls()
            placeholderElement.classList.remove('is-active')
            container.appendChild(
                html`
                    <div className="video-error-placeholder"><span innerHTML=${brokenImageIcon}></span><span>${errorMessage}</span></div>
                `,
            )

            return
        }

        const videoSource = videoUrl || (assetId ? buildAssetRenditionPath(assetId, 'original') : '')

        if (
            isPending
            || !videoSource
        ) {
            titleElement.hidden = true
            clearErrorPlaceholder()
            applyStyle(videoElement, { display: 'none' })
            applyStyle(controlsHost, { display: 'none' })
            destroyVideoControls()
            placeholderElement.classList.add('is-active')
            placeholderText.textContent = 'Generating video…'

            return
        }

        clearErrorPlaceholder()
        titleElement.hidden = false
        placeholderElement.classList.remove('is-active')
        applyStyle(videoElement, { display: 'block' })
        applyStyle(controlsHost, { display: 'block' })

        const resolvedVideoSrc = await buildAuthenticatedUrl(auth, videoSource)
        const posterSource = posterUrl || (assetId ? buildAssetRenditionPath(assetId, 'poster') : '')
        const resolvedPosterSrc = posterSource ? await buildAuthenticatedUrl(auth, posterSource) : ''

        if (videoElement.src !== resolvedVideoSrc)
            videoElement.src = resolvedVideoSrc

        if (
            resolvedPosterSrc
            && videoElement.poster !== resolvedPosterSrc
        )
            videoElement.poster = resolvedPosterSrc

        ensureVideoControls()
    }

    const updateDisplaySafely = async (): Promise<void> => {
        try {
            await updateDisplay()
        } catch {
            // The media element's error handler owns the unavailable state.
        }
    }

    videoElement.onerror = () => {
        titleElement.hidden = true
        clearErrorPlaceholder()
        applyStyle(videoElement, { display: 'none' })
        applyStyle(controlsHost, { display: 'none' })
        destroyVideoControls()
        container.appendChild(
            html`
                <div className="video-error-placeholder"><span innerHTML=${brokenImageIcon}></span><span>Video unavailable</span></div>
            `,
        )
    }

    void updateDisplaySafely()
    unsubscribeAiModelsStore = aiModelsStore.subscribe(() => updateModelChrome())
    syncContainerGeometry()

    return {
        dom: wrapper,
        update: (updatedNode: any) => {
            if (updatedNode.type.name !== aiGeneratedVideoNodeType)
                return false

            node = updatedNode
            syncContainerGeometry()
            void updateDisplaySafely()
            updateModelChrome()

            return true
        },
        destroy: () => {
            wrapper.removeEventListener('click', handleClick)
            unsubscribeAiModelsStore?.()
            unsubscribeAiModelsStore = null
            resizeObserver?.disconnect()
            resizeObserver = null
            destroyVideoControls()

            try {
                videoElement.pause()
                videoElement.removeAttribute('src')
                videoElement.load()
            } catch {
                // Pause/teardown is best-effort during ProseMirror destroy.
            }
        },
        stopEvent: (event: Event) => {
            const target = event.target as HTMLElement | null

            return Boolean(target?.closest('.ai-generated-video-controls-host') || target === videoElement)
        },
    }
}
