import {
    type Node as ProseMirrorNode,
} from 'prosemirror-model'
import {
    type EditorView,
    type NodeView,
} from 'prosemirror-view'
import { NodeSelection } from 'prosemirror-state'
import {
    imageResizeCornerIcon,
    brokenImageIcon,
} from '@lixpi/ui-kit/svg'
import { renderMediaModelBadge } from '@lixpi/ui-kit/components/media-model-badge'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import {
    html,
    applyStyle,
} from '@lixpi/ui-primitives/dom'
import { resolveAuthenticatedMediaUrl } from '$src/utils/mediaUrls.ts'
import { settings } from '$src/settings.ts'
import {
    applyMediaModelBadgeStyleProperties,
    resolveMediaModelBadgeConfig,
} from '$src/components/mediaModelBadge/mediaModelBadge.ts'
import { aiModelsStore } from '$src/stores/aiModelsStore.ts'

type ImageAlignment = 'left' | 'center' | 'right'
type TextWrap = 'none' | 'left' | 'right'
type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

type ImageNodeViewOptions = {
    auth?: AuthTokenProvider
    node: ProseMirrorNode
    view: EditorView
    getPos: () => number | undefined
}

// Get the image source from node attrs (handles both 'src' and 'imageData' attributes)
const getImageSrcAttr = (node: ProseMirrorNode): string => node.attrs.src || node.attrs.imageData || ''

// Build image src with auth token if needed
const buildImageSrc = async (
    auth: AuthTokenProvider | undefined,
    src: string,
): Promise<string> => {
    return resolveAuthenticatedMediaUrl(
        src,
        {
            apiBaseUrl: import.meta.env.VITE_API_URL || '',
            getAuthToken: () => auth?.getTokenSilently() ?? Promise.resolve(false),
        },
    )
}

export class ImageNodeView implements NodeView {
    dom: HTMLElement
    contentDOM: null = null

    private view: EditorView
    private getPos: () => number | undefined
    private node: ProseMirrorNode
    private readonly auth?: AuthTokenProvider

    private figure: HTMLElement
    private titleElement: HTMLElement | null = null
    private mediaFrame: HTMLElement
    private img: HTMLImageElement
    private partialPlaceholder: HTMLElement | null = null
    private modelChromeElement: HTMLElement | null = null
    private resizeHandles: Map<ResizeCorner, HTMLElement> = new Map()

    private originalAspectRatio = 1
    private isResizing = false
    private currentSrcAttr = '' // Track the original src attr to avoid redundant updates
    private readonly resizeEnabled: boolean
    private readonly isGeneratedImage: boolean
    private unsubscribeAiModelsStore: (() => void) | null = null

    constructor({
        auth,
        node,
        view,
        getPos,
    }: ImageNodeViewOptions) {
        this.auth = auth
        this.node = node
        this.view = view
        this.getPos = getPos
        this.currentSrcAttr = getImageSrcAttr(node)
        this.resizeEnabled = view.editable
        this.isGeneratedImage = node.type.name === 'aiGeneratedImage'

        this.figure = html`
            <figure
                className=${this.buildClassName()}
                draggable=${this.resizeEnabled}
            ></figure>
        ` as HTMLElement
        this.mediaFrame = html`<div className="pm-image-media-frame"></div>` as HTMLElement
        this.img = html`<img />` as HTMLImageElement
        // Set src asynchronously to handle auth token
        this.updateImageSrc(
            getImageSrcAttr(node),
        )

        if (node.attrs.alt)
            this.img.alt = node.attrs.alt

        if (node.attrs.assetId)
            this.img.dataset.assetId = node.attrs.assetId

        if (node.attrs.documentId)
            this.img.dataset.documentId = node.attrs.documentId

        if (this.resizeEnabled) {
            const corners: ResizeCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

            for (const corner of corners) {
                const handle = this.createResizeHandle(corner)
                this.resizeHandles.set(corner, handle)
                this.mediaFrame.appendChild(handle)
            }
        }

        // Apply width if set
        if (node.attrs.width) {
            applyStyle(this.figure, { width: node.attrs.width })
            this.figure.dataset.width = node.attrs.width
        }

        // Set data attributes
        this.figure.dataset.alignment = node.attrs.alignment || 'center'
        this.figure.dataset.textWrap = node.attrs.textWrap || 'none'

        // Assemble DOM
        this.mediaFrame.appendChild(this.img)
        this.figure.appendChild(this.mediaFrame)
        this.syncGeneratedImageTitle()
        this.syncPartialPlaceholder()
        this.syncGeneratedImageModelChrome()

        // Store aspect ratio when image loads
        this.img.addEventListener('load', this.handleImageLoad)

        this.img.addEventListener('error', () => {
            applyStyle(this.img, { display: 'none' })

            if (!this.mediaFrame.querySelector('.image-error-placeholder')) {
                this.mediaFrame.appendChild(
                    html`
                        <div className="image-error-placeholder"><span innerHTML=${brokenImageIcon}></span><span>Image unavailable</span></div>
                    `,
                )
            }
        })

        // Handle selection on click
        this.figure.addEventListener('click', this.handleClick)

        this.dom = this.figure
    }

    private async updateImageSrc(src: string): Promise<void> {
        if (!src) {
            this.currentSrcAttr = ''
            this.img.removeAttribute('src')
            applyStyle(this.img, { display: 'none' })

            return
        }

        if (
            src === this.currentSrcAttr
            && this.img.src
        )
            return

        this.currentSrcAttr = src

        try {
            const resolvedSrc = await buildImageSrc(this.auth, src)

            if (this.img.src !== resolvedSrc) {
                this.mediaFrame.querySelector('.image-error-placeholder')?.remove()
                applyStyle(this.img, { display: '' })
                this.img.src = resolvedSrc
            }
        } catch (error) {
            console.error('[ImageNodeView] Failed to resolve image src:', error)
        }
    }

    private buildClassName(): string {
        const alignment = this.node.attrs.alignment || 'left'
        const textWrap = this.node.attrs.textWrap || 'none'
        const generatedMediaClassName = this.isGeneratedImage ? ' ai-generated-media-node' : ''

        return `pm-image-wrapper pm-image-align-${alignment} pm-image-wrap-${textWrap}${generatedMediaClassName}`
    }

    private applyFigureClasses(): void {
        this.figure.classList.remove(
            'pm-image-align-left',
            'pm-image-align-center',
            'pm-image-align-right',
            'pm-image-wrap-none',
            'pm-image-wrap-left',
            'pm-image-wrap-right',
        )
        this.figure.classList.add(
            'pm-image-wrapper',
            `pm-image-align-${this.node.attrs.alignment || 'left'}`,
            `pm-image-wrap-${this.node.attrs.textWrap || 'none'}`,
        )
        this.figure.classList.toggle('ai-generated-media-node', this.isGeneratedImage)
    }

    private syncPartialPlaceholder(): void {
        const shouldShowPlaceholder = Boolean(this.node.attrs.isPartial) && !getImageSrcAttr(this.node)
        this.figure.classList.toggle(
            'is-partial',
            Boolean(this.node.attrs.isPartial),
        )

        if (!shouldShowPlaceholder) {
            this.partialPlaceholder?.remove()
            this.partialPlaceholder = null

            if (getImageSrcAttr(this.node))
                applyStyle(this.img, { display: '' })

            return
        }

        applyStyle(this.img, { display: 'none' })

        if (!this.partialPlaceholder) {
            this.partialPlaceholder = html`
                <div
                    className="pm-image-generating-placeholder"
                    aria-label="Image generation in progress"
                >
                    <span className="pm-image-generating-dot"></span>
                    <span className="pm-image-generating-dot"></span>
                    <span className="pm-image-generating-dot"></span>
                </div>
            `
        }

        if (!this.partialPlaceholder.parentElement)
            this.mediaFrame.appendChild(this.partialPlaceholder)
    }

    // Generated images carry a "Final generated image" heading so the media reads as
    // the produced output (distinct from the reference items sent to the model). The
    // title only shows once a fully-generated image exists — never during the partial
    // streaming phase or when there is no image yet.
    private syncGeneratedImageTitle(): void {
        if (!this.isGeneratedImage)
            return

        const shouldShowTitle = Boolean(
            getImageSrcAttr(this.node),
        ) && !this.node.attrs.isPartial

        if (!shouldShowTitle) {
            this.titleElement?.remove()
            this.titleElement = null

            return
        }

        if (!this.titleElement)
            this.titleElement = html`<div className="ai-generated-media-section-title">Final generated image</div>` as HTMLElement

        if (this.figure.firstChild !== this.titleElement)
            this.figure.insertBefore(this.titleElement, this.figure.firstChild)
    }

    private syncGeneratedImageModelChrome(): void {
        if (!this.isGeneratedImage)
            return

        if (!this.modelChromeElement) {
            this.modelChromeElement = html`<div className="ai-generated-media-model-chrome ai-generated-media-run-meta"></div>` as HTMLElement
            applyMediaModelBadgeStyleProperties(this.figure, { scale: settings.mediaNode.generatedMediaChrome.chatScale })
            this.figure.appendChild(this.modelChromeElement)
            this.unsubscribeAiModelsStore = aiModelsStore.subscribe(() => this.renderGeneratedImageModelBadge())
        }

        this.renderGeneratedImageModelBadge()
    }

    private renderGeneratedImageModelBadge(): void {
        if (!this.modelChromeElement)
            return

        renderMediaModelBadge(
            this.modelChromeElement,
            resolveMediaModelBadgeConfig({
                modelId: this.node.attrs.mediaModelId,
            }),
        )
    }

    private createResizeHandle(corner: ResizeCorner): HTMLElement {
        const handle = html`
            <div
                className=${`pm-image-resize-handle pm-image-resize-${corner}`}
                innerHTML=${imageResizeCornerIcon}
                data=${{ corner }}
            ></div>
        ` as HTMLElement
        handle.addEventListener('mousedown', e => this.handleResizeStart(e, corner))

        return handle
    }

    private handleImageLoad = (): void => {
        if (
            this.img.naturalWidth
            && this.img.naturalHeight
        )
            this.originalAspectRatio = this.img.naturalWidth / this.img.naturalHeight
    }

    private handleClick = (event: MouseEvent): void => {
        event.preventDefault()
        event.stopPropagation()

        if (!this.view.editable)
            return

        const pos = this.getPos()

        if (pos === undefined)
            return

        // Select this node
        const tr = this.view.state.tr.setSelection(
            NodeSelection.create(this.view.state.doc, pos),
        )
        this.view.dispatch(tr)
        this.view.focus()
    }

    private handleResizeStart = (
        event: MouseEvent,
        corner: ResizeCorner,
    ): void => {
        event.preventDefault()
        event.stopPropagation()

        if (!this.view.editable)
            return

        this.isResizing = true
        this.figure.classList.add('is-resizing')

        // Mark the active handle to keep it enlarged during drag
        const activeHandle = this.resizeHandles.get(corner)
        activeHandle?.classList.add('is-dragging')

        const startX = event.clientX
        const startWidth = this.figure.getBoundingClientRect().width
        const containerWidth = this.getContainerWidth()

        // Determine resize direction based on corner
        // Left corners: dragging left increases width, right decreases
        // Right corners: dragging right increases width, left decreases
        const isLeftCorner = corner === 'top-left' || corner === 'bottom-left'
        const direction = isLeftCorner ? -1 : 1

        // Ensure we have aspect ratio
        if (
            this.img.naturalWidth
            && this.img.naturalHeight
        )
            this.originalAspectRatio = this.img.naturalWidth / this.img.naturalHeight

        const handleMouseMove = (moveEvent: MouseEvent): void => {
            const deltaX = (moveEvent.clientX - startX) * direction
            let newWidth = startWidth + deltaX

            // Clamp width between 10% and 100%
            const minWidth = containerWidth * 0.1
            const maxWidth = containerWidth
            newWidth = Math.max(
                minWidth,
                Math.min(maxWidth, newWidth),
            )

            // Calculate percentage
            const widthPercent = Math.round((newWidth / containerWidth) * 100)

            // Apply visually during drag
            applyStyle(this.figure, { width: `${widthPercent}%` })

            // Dispatch custom event so toolbar can reposition
            this.view.dom.dispatchEvent(
                new CustomEvent('image-resize', { bubbles: true }),
            )
        }

        const handleMouseUp = (): void => {
            this.isResizing = false
            this.figure.classList.remove('is-resizing')
            activeHandle?.classList.remove('is-dragging')

            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)

            // Commit the change to ProseMirror state
            const pos = this.getPos()

            if (pos === undefined)
                return

            const containerWidth = this.getContainerWidth()
            const currentWidth = this.figure.getBoundingClientRect().width
            const widthPercent = `${Math.round((currentWidth / containerWidth) * 100)}%`

            const tr = this.view.state.tr.setNodeMarkup(
                pos,
                null,
                {
                    ...this.node.attrs,
                    width: widthPercent,
                },
            )

            // Re-select the node after resize to keep it selected
            tr.setSelection(
                NodeSelection.create(tr.doc, pos),
            )

            this.view.dispatch(tr)
            this.view.focus()
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
    }

    private getContainerWidth(): number {
        // Get the editor's content width for percentage calculations
        const editorDom = this.view.dom
        const computedStyle = getComputedStyle(editorDom)
        const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0
        const paddingRight = parseFloat(computedStyle.paddingRight) || 0

        return editorDom.clientWidth - paddingLeft - paddingRight
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type !== this.node.type)
            return false

        this.node = node

        // Update image src asynchronously to handle auth token
        this.updateImageSrc(
            getImageSrcAttr(node),
        )
        this.syncGeneratedImageTitle()
        this.syncPartialPlaceholder()
        this.syncGeneratedImageModelChrome()

        if (node.attrs.alt !== this.img.alt)
            this.img.alt = node.attrs.alt || ''

        // Update width
        if (node.attrs.width) {
            applyStyle(this.figure, { width: node.attrs.width })
            this.figure.dataset.width = node.attrs.width
        } else {
            applyStyle(this.figure, { width: '' })
            delete this.figure.dataset.width
        }

        // Update classes for alignment and text wrap
        this.applyFigureClasses()
        this.figure.dataset.alignment = node.attrs.alignment || 'center'
        this.figure.dataset.textWrap = node.attrs.textWrap || 'none'

        return true
    }

    selectNode(): void {
        this.figure.classList.add('ProseMirror-selectednode')
    }

    deselectNode(): void {
        this.figure.classList.remove('ProseMirror-selectednode')
    }

    stopEvent(event: Event): boolean {
        // Allow resize handles to capture mouse events
        const target = event.target as HTMLElement

        if (target.closest('.pm-image-resize-handle'))
            return true

        return false
    }

    ignoreMutation(): boolean {
        return true
    }

    destroy(): void {
        for (const handle of this.resizeHandles.values()) {
            handle.remove()
        }

        this.resizeHandles.clear()
        this.img.removeEventListener('load', this.handleImageLoad)
        this.figure.removeEventListener('click', this.handleClick)
        this.unsubscribeAiModelsStore?.()
        this.unsubscribeAiModelsStore = null
    }
}
