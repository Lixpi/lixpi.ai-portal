import {
    Plugin,
    PluginKey,
    NodeSelection,
} from 'prosemirror-state'
import {
    type Node as ProseMirrorNode,
} from 'prosemirror-model'
import {
    type EditorView,
} from 'prosemirror-view'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import {
    BubbleMenu,
    type BubbleMenuPositionRequest,
} from '@lixpi/ui-kit/components/bubble-menu'
import {
    buildBubbleMenuItems,
    getSelectionContext,
    updateImageButtonStates,
    type MenuItemElement,
    type SelectionContext,
} from '$src/components/proseMirror/plugins/bubbleMenuPlugin/bubbleMenuItems.ts'

export const bubbleMenuPluginKey = new PluginKey('bubbleMenu')

const isTouchDevice = (): boolean => 'ontouchstart' in window || navigator.maxTouchPoints > 0

const resolvedPositionHasNodeType = (
    position: {
        depth: number
        node: (depth: number) => ProseMirrorNode
    },
    nodeType: string,
): boolean => {
    for (let depth = position.depth; depth >= 0; depth -= 1) {
        if (position.node(depth).type.name === nodeType)
            return true
    }

    return false
}

type BubbleMenuViewOptions = {
    auth?: AuthTokenProvider
    view: EditorView
}

class BubbleMenuView {
    private view: EditorView
    private bubbleMenu: BubbleMenu
    private menuItems: MenuItemElement[] = []
    private updateDebounceTimer: ReturnType<typeof setTimeout> | null = null
    private readonly debounceDelay: number
    private linkInputPanel: HTMLElement | null = null
    private isLinkInputActive = false
    private isSelecting = false
    private currentContext: SelectionContext = 'none'
    private activeImageWrapper: HTMLElement | null = null

    constructor({
        auth,
        view,
    }: BubbleMenuViewOptions) {
        this.view = view
        this.debounceDelay = isTouchDevice() ? 350 : 200

        const {
            items,
            linkInputPanel,
        } = buildBubbleMenuItems(
            this.view,
            this,
            auth,
        )
        this.menuItems = items
        this.linkInputPanel = linkInputPanel

        const menuParent = view.dom.parentNode as HTMLElement

        this.bubbleMenu = new BubbleMenu({
            parentEl: menuParent,
            items: this.menuItems,
            panels: this.linkInputPanel ? [this.linkInputPanel] : [],
            onHide: () => {
                this.currentContext = 'none'
                this.closeLinkInput()
                this.activeImageWrapper?.classList.remove('pm-image-menu-active')
                this.activeImageWrapper = null
            },
        })

        // Track selection state
        view.dom.addEventListener('mousedown', this.handleEditorMouseDown)
        view.dom.addEventListener('touchstart', this.handleEditorTouchStart)
        document.addEventListener('mouseup', this.handleDocumentMouseUp)
        document.addEventListener('touchend', this.handleDocumentTouchEnd)

        // Listen for image resize events
        view.dom.addEventListener('image-resize', this.handleImageResize)
    }

    // Expose view for image actions
    getView(): EditorView {
        return this.view
    }

    private handleEditorMouseDown = (): void => {
        this.isSelecting = true
        this.bubbleMenu.hide()
    }

    private handleEditorTouchStart = (): void => void (this.isSelecting = true)

    private handleDocumentMouseUp = (): void => {
        if (this.isSelecting) {
            this.isSelecting = false
            setTimeout(() => this.showIfNeeded(), 10)
        }
    }

    private handleDocumentTouchEnd = (): void => {
        if (this.isSelecting) {
            this.isSelecting = false
            setTimeout(() => this.showIfNeeded(), 100)
        }
    }

    private handleImageResize = (): void => {
        if (
            this.currentContext === 'image'
            && this.bubbleMenu.isVisible
        ) {
            const position = this.getPositionRequest()

            if (position)
                this.bubbleMenu.reposition(position)
        }
    }

    private showIfNeeded(): void {
        const context = getSelectionContext(this.view)

        if (
            context !== 'none'
            && this.shouldShow(context)
            && !this.isSelecting
        ) {
            this.currentContext = context
            const position = this.getPositionRequest()

            if (position) {
                this.bubbleMenu.show(context, position)
                this.markImageActive()
                this.updateMenuState()
            }
        }
    }

    private shouldShow(context: SelectionContext): boolean {
        if (!this.view.hasFocus())
            return false

        if (!this.view.editable)
            return false

        if (context === 'none')
            return false

        const { state } = this.view
        const { selection } = state
        const {
            $from,
            $to,
        } = selection

        const selectsDocumentTitle = selection instanceof NodeSelection
            ? selection.node.type.name === 'documentTitle'
            : resolvedPositionHasNodeType($from, 'documentTitle')
                || resolvedPositionHasNodeType($to, 'documentTitle')

        if (selectsDocumentTitle)
            return false

        // Don't show in code blocks
        const isCodeBlock = $from.parent.type.name === 'code_block' || $to.parent.type.name === 'code_block'

        if (isCodeBlock)
            return false

        return true
    }

    private getImageElement(): HTMLImageElement | null {
        const { selection } = this.view.state

        if (!(selection instanceof NodeSelection))
            return null

        const nodeType = selection.node.type.name

        if (
            nodeType !== 'image'
            && nodeType !== 'aiGeneratedImage'
        )
            return null

        const nodeDom = this.view.nodeDOM(selection.from)

        if (!nodeDom)
            return null

        const element = nodeDom as HTMLElement

        if (element.classList?.contains('pm-image-wrapper')) {
            const img = element.querySelector('img')

            if (img)
                return img
        }

        if (element.tagName === 'IMG')
            return element as HTMLImageElement

        const img = element.querySelector?.('img')

        if (img)
            return img

        return null
    }

    private getImageWrapper(): HTMLElement | null {
        const { selection } = this.view.state

        if (!(selection instanceof NodeSelection))
            return null

        const nodeType = selection.node.type.name

        if (
            nodeType !== 'image'
            && nodeType !== 'aiGeneratedImage'
        )
            return null

        const nodeDom = this.view.nodeDOM(selection.from)

        if (!nodeDom)
            return null

        const element = nodeDom as HTMLElement

        if (element.classList?.contains('pm-image-wrapper'))
            return element

        return null
    }

    private getPositionRequest(): BubbleMenuPositionRequest | null {
        if (this.currentContext === 'image') {
            const imgElement = this.getImageElement()

            if (!imgElement)
                return null

            return {
                targetRect: imgElement.getBoundingClientRect(),
                placement: 'below',
            }
        }

        // Text context: compute selection bounding rect
        const { state } = this.view
        const {
            from,
            to,
        } = state.selection

        const start = this.view.coordsAtPos(from)
        const end = this.view.coordsAtPos(to)

        const left = Math.min(start.left, end.left)
        const right = Math.max(start.right, end.right)
        const top = Math.min(start.top, end.top)
        const bottom = Math.max(start.bottom, end.bottom)

        const targetRect = new DOMRect(
            left,
            top,
            right - left,
            bottom - top,
        )

        return {
            targetRect,
            placement: 'above',
        }
    }

    update(): void {
        if (this.isSelecting)
            return

        const wasVisible = this.bubbleMenu.isVisible
        const context = getSelectionContext(this.view)

        if (this.bubbleMenu.preventHide) {
            this.bubbleMenu.preventHide = false
            this.currentContext = context !== 'none' ? context : this.currentContext
            this.updateMenuState()
            this.markImageActive()
            // Reposition after state change (e.g., alignment changed)
            const position = this.getPositionRequest()

            if (position)
                requestAnimationFrame(() => void this.bubbleMenu.reposition(position))

            return
        }

        if (this.isLinkInputActive)
            return

        const shouldBeVisible = context !== 'none' && this.shouldShow(context)

        if (
            shouldBeVisible
            && !wasVisible
        ) {
            this.currentContext = context
            const position = this.getPositionRequest()

            if (position) {
                this.bubbleMenu.show(context, position)
                this.markImageActive()
                this.updateMenuState()
            }
        } else if (
            shouldBeVisible
            && wasVisible
        ) {
            // Context might have changed
            if (context !== this.currentContext)
                this.currentContext = context

            if (this.updateDebounceTimer)
                clearTimeout(this.updateDebounceTimer)

            this.updateDebounceTimer = setTimeout(
                () => {
                    this.updateMenuState()
                    const position = this.getPositionRequest()

                    if (position)
                        this.bubbleMenu.updateContext(context, position)
                },
                this.debounceDelay,
            )
        } else if (!shouldBeVisible)
            this.bubbleMenu.hide()
    }

    private updateMenuState(): void {
        if (this.currentContext === 'text') {
            // Update mark button states
            const buttons = this.bubbleMenu.element.querySelectorAll('.bubble-menu-button')
            buttons.forEach(button => {
                const updateFn = (button as HTMLElement).dataset.update

                if (updateFn) {
                    const isActive = this.checkMarkActive((button as HTMLElement).dataset.markType || '')
                    button.classList.toggle('is-active', isActive)
                }
            })

            // Update dropdown labels
            for (const item of this.menuItems) {
                if (item.update)
                    item.update()
            }
        } else if (this.currentContext === 'image') {
            // Update image button states (alignment, wrap)
            updateImageButtonStates(this.menuItems, this.view)
        }
    }

    private checkMarkActive(markType: string): boolean {
        const { state } = this.view
        const {
            from,
            $from,
            to,
            empty,
        } = state.selection
        const type = state.schema.marks[markType]

        if (!type)
            return false

        if (empty)
            return !!type.isInSet(state.storedMarks || $from.marks())

        return state.doc.rangeHasMark(
            from,
            to,
            type,
        )
    }

    private markImageActive(): void {
        if (this.currentContext === 'image') {
            const wrapper = this.getImageWrapper()

            if (
                wrapper
                && wrapper !== this.activeImageWrapper
            ) {
                this.activeImageWrapper?.classList.remove('pm-image-menu-active')
                this.activeImageWrapper = wrapper
            }

            this.activeImageWrapper?.classList.add('pm-image-menu-active')
        }
    }

    forceHide(): void {
        this.bubbleMenu.forceHide()
    }

    showLinkInput(): void {
        this.isLinkInputActive = true

        if (this.linkInputPanel) {
            this.linkInputPanel.classList.add('is-active')
            const input = this.linkInputPanel.querySelector('input') as HTMLInputElement

            if (input) {
                const { state } = this.view
                const {
                    from,
                    to,
                } = state.selection
                const linkMark = state.schema.marks.link
                let existingHref = ''

                state.doc.nodesBetween(
                    from,
                    to,
                    (node: ProseMirrorNode) => {
                        const mark = linkMark.isInSet(node.marks)

                        if (mark)
                            existingHref = mark.attrs.href || ''
                    },
                )

                input.value = existingHref
                setTimeout(() => input.focus(), 0)
            }
        }
    }

    closeLinkInput(): void {
        this.isLinkInputActive = false

        if (this.linkInputPanel)
            this.linkInputPanel.classList.remove('is-active')
    }

    applyLink(href: string): void {
        const {
            state,
            dispatch,
        } = this.view
        const {
            from,
            to,
        } = state.selection
        const linkMark = state.schema.marks.link

        if (!href.trim())
            dispatch(
                state.tr.removeMark(
                    from,
                    to,
                    linkMark,
                ),
            )
        else {
            const normalizedHref = href.startsWith('http://')
                || href.startsWith('https://')
                ? href
                : `https://${href}`
            dispatch(
                state.tr.addMark(
                    from,
                    to,
                    linkMark.create({ href: normalizedHref }),
                ),
            )
        }

        this.closeLinkInput()
        this.view.focus()
    }

    removeLink(): void {
        const {
            state,
            dispatch,
        } = this.view
        const {
            from,
            to,
        } = state.selection
        const linkMark = state.schema.marks.link
        dispatch(
            state.tr.removeMark(
                from,
                to,
                linkMark,
            ),
        )
        this.closeLinkInput()
        this.view.focus()
    }

    destroy(): void {
        if (this.updateDebounceTimer)
            clearTimeout(this.updateDebounceTimer)

        this.view.dom.removeEventListener('mousedown', this.handleEditorMouseDown)
        this.view.dom.removeEventListener('touchstart', this.handleEditorTouchStart)
        this.view.dom.removeEventListener('image-resize', this.handleImageResize)
        document.removeEventListener('mouseup', this.handleDocumentMouseUp)
        document.removeEventListener('touchend', this.handleDocumentTouchEnd)
        this.bubbleMenu.destroy()
    }
}

export const bubbleMenuPlugin = (auth?: AuthTokenProvider): Plugin => {
    return new Plugin({
        key: bubbleMenuPluginKey,
        view(editorView: EditorView) {
            return new BubbleMenuView({
                auth,
                view: editorView,
            })
        },
    })
}

export { BubbleMenuView }
