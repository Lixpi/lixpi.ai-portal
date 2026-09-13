import { brokenImageIcon } from '@lixpi/ui-kit/svg'
import { renderMediaModelBadge } from '@lixpi/ui-kit/components/media-model-badge'
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
import {
    applyMediaModelBadgeStyleProperties,
    resolveMediaModelBadgeConfig,
} from '$src/components/mediaModelBadge/mediaModelBadge.ts'
import { aiModelsStore } from '$src/stores/aiModelsStore.ts'
import { NodeSelection } from 'prosemirror-state'
import {
    aiGeneratedImageNodeSpec,
    aiGeneratedImageNodeType,
} from '@lixpi/prosemirror'

export {
    aiGeneratedImageNodeSpec,
    aiGeneratedImageNodeType,
}

export const aiGeneratedImageNodeView = (
    node: any,
    view: any,
    getPos: () => number | undefined,
    auth?: AuthTokenProvider,
) => {
    const wrapper = html`
        <div className="ai-generated-image-wrapper ai-generated-media-node">
            <div className="ai-generated-media-section-title">Final generated image</div>
            <div className="ai-generated-image-container">
                <div className="ai-generated-image-spinner">
                    <div className="spinner-ring"></div>
                    <span className="spinner-text">Generating image...</span>
                </div>
                <img
                    className="ai-generated-image-content"
                    alt=""
                />
            </div>
            <div className="ai-generated-media-model-chrome ai-generated-media-run-meta"></div>
        </div>
    `

    const container = wrapper.querySelector('.ai-generated-image-container') as HTMLElement
    const titleElement = wrapper.querySelector('.ai-generated-media-section-title') as HTMLElement
    const spinnerElement = wrapper.querySelector('.ai-generated-image-spinner') as HTMLElement
    const imageElement = wrapper.querySelector('.ai-generated-image-content') as HTMLImageElement
    const modelChromeElement = wrapper.querySelector('.ai-generated-media-model-chrome') as HTMLElement
    titleElement.hidden = true
    applyMediaModelBadgeStyleProperties(wrapper, { scale: settings.mediaNode.generatedMediaChrome.chatScale })
    let unsubscribeAiModelsStore: (() => void) | null = null

    // Click handler to select the node (needed for bubble menu)
    const handleClick = (event: MouseEvent) => {
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
                modelId: node.attrs.mediaModelId,
            }),
        )
    }

    const updateDisplay = async () => {
        const {
            imageData,
            assetId,
            isPartial,
        } = node.attrs

        const imageSource = imageData || (assetId ? buildAssetRenditionPath(assetId, 'preview') : '')

        if (!imageSource) {
            titleElement.hidden = true
            spinnerElement.classList.add('is-active')
            imageElement.classList.remove('is-visible')

            return
        }

        titleElement.hidden = Boolean(isPartial)
        spinnerElement.classList.remove('is-active')
        imageElement.classList.add('is-visible')

        const imageSrc = await resolveAuthenticatedMediaUrl(
            imageSource,
            {
                apiBaseUrl: import.meta.env.VITE_API_URL || '',
                base64MimeType: 'image/png',
                getAuthToken: () => auth?.getTokenSilently() ?? Promise.resolve(false),
            },
        )

        if (imageElement.src !== imageSrc)
            imageElement.src = imageSrc

        if (isPartial)
            container.classList.add('is-partial')
        else
            container.classList.remove('is-partial')
    }

    const updateDisplaySafely = async (): Promise<void> => {
        try {
            await updateDisplay()
        } catch {
            // The media element's error handler owns the unavailable state.
        }
    }

    imageElement.onerror = () => {
        titleElement.hidden = true
        applyStyle(imageElement, { display: 'none' })

        if (!container.querySelector('.image-error-placeholder')) {
            container.appendChild(
                html`
                    <div className="image-error-placeholder"><span innerHTML=${brokenImageIcon}></span><span>Image unavailable</span></div>
                `,
            )
        }
    }

    void updateDisplaySafely()
    unsubscribeAiModelsStore = aiModelsStore.subscribe(() => updateModelChrome())

    return {
        dom: wrapper,
        update: (updatedNode: any) => {
            if (updatedNode.type.name !== aiGeneratedImageNodeType)
                return false

            node = updatedNode
            void updateDisplaySafely()
            updateModelChrome()

            return true
        },
        destroy: () => {
            wrapper.removeEventListener('click', handleClick)
            unsubscribeAiModelsStore?.()
            unsubscribeAiModelsStore = null
        },
        stopEvent: (event: Event) => false,
    }
}
