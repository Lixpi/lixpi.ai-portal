import {
    type EditorView,
} from 'prosemirror-view'
import {
    type Schema,
    type Node as ProseMirrorNode,
} from 'prosemirror-model'
import {
    toggleMark,
    wrapIn,
    setBlockType,
} from 'prosemirror-commands'
import { NodeSelection } from 'prosemirror-state'
import {
    createEl,
    applyStyle,
} from '@lixpi/ui-primitives/dom'
import {
    type BubbleMenuItem,
} from '@lixpi/ui-kit/components/bubble-menu'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import {
    boldIcon,
    italicIcon,
    strikethroughIcon,
    inlineCodeIcon,
    codeBlockIcon,
    blockquoteIcon,
    linkIcon,
    chevronDownIcon,
    paragraphIcon,
    heading1Icon,
    heading2Icon,
    heading3Icon,
    checkMarkIcon,
    trashBinIcon,
    alignLeftIcon,
    alignCenterIcon,
    alignRightIcon,
    downloadIcon,
} from '@lixpi/ui-kit/svg'
import { downloadImage } from '$src/utils/downloadImage.ts'

// =============================================================================
// SELECTION CONTEXT TYPES
// =============================================================================

export type SelectionContext = 'text' | 'image' | 'none'

export const getSelectionContext = (view: EditorView): SelectionContext => {
    const { selection } = view.state

    if (selection instanceof NodeSelection) {
        if (
            selection.node.type.name === 'image'
            || selection.node.type.name === 'aiGeneratedImage'
        )
            return 'image'

        return 'none'
    }

    if (!selection.empty)
        return 'text'

    return 'none'
}

// =============================================================================
// BUBBLE MENU VIEW INTERFACE
// =============================================================================

type BubbleMenuView = {
    showLinkInput: () => void
    closeLinkInput: () => void
    applyLink: (href: string) => void
    removeLink: () => void
    getView: () => EditorView
    forceHide: () => void
}

type Command = (
    state: EditorView['state'],
    dispatch?: EditorView['dispatch'],
) => boolean

// =============================================================================
// TEXT WRAP ICONS
// =============================================================================

const wrapNoneIcon = '<svg fill="none" height="20" viewBox="0 0 20 20" width="20" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="14" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="6" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="12" x2="14" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>'
const wrapLeftIcon = '<svg fill="none" height="20" viewBox="0 0 20 20" width="20" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="6" width="6" height="8" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="11" y1="6" x2="17" y2="6" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="14" x2="17" y2="14" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="17" x2="17" y2="17" stroke="currentColor" stroke-width="1.5"/></svg>'
const wrapRightIcon = '<svg fill="none" height="20" viewBox="0 0 20 20" width="20" xmlns="http://www.w3.org/2000/svg"><rect x="11" y="6" width="6" height="8" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="10" x2="9" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="14" x2="9" y2="14" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="17" x2="17" y2="17" stroke="currentColor" stroke-width="1.5"/></svg>'
const magicIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>'

// =============================================================================
// MENU CONFIGURATION
// =============================================================================

type MenuItemBase = {
    context: SelectionContext[] // Which contexts this item appears in
}

type SeparatorItem = MenuItemBase & { type: 'separator' }

type DropdownItem = MenuItemBase & {
    type: 'dropdown'
    key: string
    defaultIcon: string
    options: Array<{
        icon: string
        node: string
        attrs?: Record<string, unknown>
    }>
}

type MarkItem = MenuItemBase & {
    type: 'mark'
    key: string
    mark: string
    icon: string
    title: string
    iconSize: number
    action?: 'showLinkInput'
}

type BlockItem = MenuItemBase & {
    type: 'block'
    key: string
    node: string
    icon: string
    title: string
    iconSize: number
}

type BlockWrapItem = MenuItemBase & {
    type: 'blockWrap'
    key: string
    node: string
    icon: string
    title: string
    iconSize: number
}

type ImageAlignmentItem = MenuItemBase & {
    type: 'imageAlignment'
    key: string
    alignment: 'left' | 'center' | 'right'
    icon: string
    title: string
    iconSize: number
}

type ImageWrapItem = MenuItemBase & {
    type: 'imageWrap'
    key: string
    wrap: 'none' | 'left' | 'right'
    icon: string
    title: string
    iconSize: number
}

type ImageActionItem = MenuItemBase & {
    type: 'imageAction'
    key: string
    action: 'delete' | 'blockquote' | 'createVariant' | 'download'
    icon: string
    title: string
    iconSize: number
}

type MenuItem = SeparatorItem | DropdownItem | MarkItem | BlockItem | BlockWrapItem | ImageAlignmentItem | ImageWrapItem | ImageActionItem

const MENU_ITEMS: MenuItem[] = [
    // ==========================================================================
    // TEXT SELECTION ITEMS
    // ==========================================================================

    // Text type dropdown
    {
        type: 'dropdown',
        key: 'textType',
        defaultIcon: paragraphIcon,
        context: ['text'],
        options: [
            {
                icon: paragraphIcon,
                node: 'paragraph',
            },
            {
                icon: heading1Icon,
                node: 'heading',
                attrs: { level: 1 },
            },
            {
                icon: heading2Icon,
                node: 'heading',
                attrs: { level: 2 },
            },
            {
                icon: heading3Icon,
                node: 'heading',
                attrs: { level: 3 },
            },
        ],
    },

    {
        type: 'separator',
        context: ['text'],
    },

    // Mark buttons (inline formatting)
    {
        type: 'mark',
        key: 'bold',
        mark: 'strong',
        icon: boldIcon,
        title: 'Bold (Ctrl+B)',
        iconSize: 14,
        context: ['text'],
    },
    {
        type: 'mark',
        key: 'italic',
        mark: 'em',
        icon: italicIcon,
        title: 'Italic (Ctrl+I)',
        iconSize: 13,
        context: ['text'],
    },
    {
        type: 'mark',
        key: 'strikethrough',
        mark: 'strikethrough',
        icon: strikethroughIcon,
        title: 'Strikethrough',
        iconSize: 15,
        context: ['text'],
    },
    {
        type: 'mark',
        key: 'link',
        mark: 'link',
        icon: linkIcon,
        title: 'Link',
        iconSize: 15,
        action: 'showLinkInput',
        context: ['text'],
    },
    {
        type: 'mark',
        key: 'inlineCode',
        mark: 'code',
        icon: inlineCodeIcon,
        title: 'Inline Code',
        iconSize: 16,
        context: ['text'],
    },

    {
        type: 'separator',
        context: ['text'],
    },

    // Block buttons
    {
        type: 'block',
        key: 'codeBlock',
        node: 'code_block',
        icon: codeBlockIcon,
        title: 'Code Block',
        iconSize: 17,
        context: ['text'],
    },
    {
        type: 'blockWrap',
        key: 'blockquote',
        node: 'blockquote',
        icon: blockquoteIcon,
        title: 'Blockquote',
        iconSize: 17,
        context: ['text'],
    },

    // ==========================================================================
    // IMAGE SELECTION ITEMS
    // ==========================================================================

    // Alignment buttons
    {
        type: 'imageAlignment',
        key: 'alignLeft',
        alignment: 'left',
        icon: alignLeftIcon,
        title: 'Align left',
        iconSize: 16,
        context: ['image'],
    },
    {
        type: 'imageAlignment',
        key: 'alignCenter',
        alignment: 'center',
        icon: alignCenterIcon,
        title: 'Align center',
        iconSize: 16,
        context: ['image'],
    },
    {
        type: 'imageAlignment',
        key: 'alignRight',
        alignment: 'right',
        icon: alignRightIcon,
        title: 'Align right',
        iconSize: 16,
        context: ['image'],
    },

    {
        type: 'separator',
        context: ['image'],
    },

    // Text wrap buttons
    {
        type: 'imageWrap',
        key: 'wrapNone',
        wrap: 'none',
        icon: wrapNoneIcon,
        title: 'No text wrap',
        iconSize: 16,
        context: ['image'],
    },
    {
        type: 'imageWrap',
        key: 'wrapLeft',
        wrap: 'left',
        icon: wrapLeftIcon,
        title: 'Wrap text right',
        iconSize: 16,
        context: ['image'],
    },
    {
        type: 'imageWrap',
        key: 'wrapRight',
        wrap: 'right',
        icon: wrapRightIcon,
        title: 'Wrap text left',
        iconSize: 16,
        context: ['image'],
    },

    {
        type: 'separator',
        context: ['image'],
    },

    // Image actions
    {
        type: 'imageAction',
        key: 'createVariant',
        action: 'createVariant',
        icon: magicIcon,
        title: 'Create variant',
        iconSize: 17,
        context: ['image'],
    },
    {
        type: 'imageAction',
        key: 'imageDownload',
        action: 'download',
        icon: downloadIcon,
        title: 'Download image',
        iconSize: 16,
        context: ['image'],
    },
    {
        type: 'imageAction',
        key: 'imageBlockquote',
        action: 'blockquote',
        icon: blockquoteIcon,
        title: 'Wrap in blockquote',
        iconSize: 17,
        context: ['image'],
    },
    {
        type: 'imageAction',
        key: 'imageDelete',
        action: 'delete',
        icon: trashBinIcon,
        title: 'Delete image',
        iconSize: 16,
        context: ['image'],
    },
]

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

const getMarkCommand = (
    schema: Schema,
    markName: string,
): Command | null => {
    const markType = schema.marks[markName]

    return markType ? (state, dispatch) => toggleMark(markType)(state, dispatch) : null
}

const getBlockCommand = (
    schema: Schema,
    nodeName: string,
): Command | null => {
    const nodeType = schema.nodes[nodeName]

    return nodeType ? (state, dispatch) => setBlockType(nodeType)(state, dispatch) : null
}

const getBlockWrapCommand = (
    schema: Schema,
    nodeName: string,
): Command | null => {
    const nodeType = schema.nodes[nodeName]

    return nodeType ? (state, dispatch) => wrapIn(nodeType)(state, dispatch) : null
}

const getSelectedImageNode = (view: EditorView): {
    pos: number
    node: ProseMirrorNode
} | null => {
    const { selection } = view.state

    if (!(selection instanceof NodeSelection))
        return null

    const nodeType = selection.node.type.name

    if (
        nodeType !== 'image'
        && nodeType !== 'aiGeneratedImage'
    )
        return null

    return {
        pos: selection.from,
        node: selection.node,
    }
}

// =============================================================================
// BUTTON CREATORS
// =============================================================================

const createButton = (
    item: {
        key: string
        icon: string
        title: string
        iconSize: number
        action?: 'showLinkInput'
    },
    command: Command | null,
    view: EditorView,
    bubbleMenuView: BubbleMenuView,
    markType?: string,
): HTMLElement | null => {
    if (!command)
        return null

    const button = createEl(
        'button',
        {
            className: 'bubble-menu-button',
            type: 'button',
            'aria-label': item.title,
            innerHTML: item.icon,
            data: { helpTooltip: 'aria-label' },
        },
    )

    const svg = button.querySelector('svg')

    if (svg)
        applyStyle(
            svg,
            {
                width: `${item.iconSize}px`,
                height: `${item.iconSize}px`,
            },
        )

    if (markType) {
        button.dataset.markType = markType
        button.dataset.update = 'true'
    }

    button.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()

        if (item.action === 'showLinkInput')
            bubbleMenuView.showLinkInput()
        else
            command(view.state, view.dispatch)

        view.focus()
    })

    return button
}

const createSeparator = (): HTMLElement => createEl('span', { className: 'bubble-menu-separator' })

const createDropdown = (
    item: DropdownItem,
    view: EditorView,
): {
    element: HTMLElement
    update: () => void
} => {
    const { schema } = view.state
    const menu = createEl('div', { className: 'bubble-menu-dropdown-menu' })

    const labelSpan = createEl(
        'span',
        {
            className: 'dropdown-label',
            innerHTML: item.defaultIcon,
        },
    )

    const optionButtons: Array<{
        btn: HTMLElement
        node: string
        attrs?: Record<string, unknown>
    }> = []

    item.options.forEach(opt => {
        const nodeType = schema.nodes[opt.node]

        if (!nodeType)
            return

        const btn = createEl(
            'button',
            {
                className: 'bubble-menu-dropdown-item',
                type: 'button',
                innerHTML: opt.icon,
            },
        )

        optionButtons.push({
            btn,
            node: opt.node,
            attrs: opt.attrs,
        })

        btn.addEventListener('click', e => {
            e.preventDefault()
            e.stopPropagation()
            setBlockType(nodeType, opt.attrs)(view.state, view.dispatch)
            view.focus()
            menu.classList.remove('is-open')
        })

        menu.appendChild(btn)
    })

    const toggle = createEl(
        'button',
        {
            className: 'bubble-menu-dropdown-toggle',
            type: 'button',
        },
    )
    toggle.appendChild(labelSpan)
    toggle.insertAdjacentHTML('beforeend', chevronDownIcon)

    const wrapper = createEl(
        'div',
        { className: 'bubble-menu-dropdown' },
        toggle,
        menu,
    )

    toggle.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        menu.classList.toggle('is-open')
    })

    document.addEventListener('click', e => {
        if (!wrapper.contains(e.target as Node))
            menu.classList.remove('is-open')
    })

    const update = (): void => {
        const { state } = view
        const { $from } = state.selection
        const parentNode = $from.parent

        let currentIcon = item.defaultIcon

        for (const opt of item.options) {
            if (parentNode.type.name === opt.node) {
                if (opt.attrs) {
                    const attrsMatch = Object.entries(opt.attrs).every(([key, value]) => parentNode.attrs[key] === value)

                    if (attrsMatch) {
                        currentIcon = opt.icon

                        break
                    }
                } else {
                    currentIcon = opt.icon

                    break
                }
            }
        }

        labelSpan.innerHTML = currentIcon

        for (const {
            btn,
            node,
            attrs,
        } of optionButtons) {
            let isActive = parentNode.type.name === node

            if (
                isActive
                && attrs
            )
                isActive = Object.entries(attrs).every(([key, value]) => parentNode.attrs[key] === value)

            btn.classList.toggle('is-active', isActive)
        }
    }

    return {
        element: wrapper,
        update,
    }
}

const createImageAlignmentButton = (
    item: ImageAlignmentItem,
    bubbleMenuView: BubbleMenuView,
): HTMLElement => {
    const button = createEl(
        'button',
        {
            className: 'bubble-menu-button',
            type: 'button',
            'aria-label': item.title,
            innerHTML: item.icon,
            data: {
                helpTooltip: 'aria-label',
                imageAlignment: item.alignment,
            },
        },
    )

    const svg = button.querySelector('svg')

    if (svg)
        applyStyle(
            svg,
            {
                width: `${item.iconSize}px`,
                height: `${item.iconSize}px`,
            },
        )

    button.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()

        const view = bubbleMenuView.getView()
        const imageInfo = getSelectedImageNode(view)

        if (!imageInfo)
            return

        const {
            pos,
            node,
        } = imageInfo
        const tr = view.state.tr.setNodeMarkup(
            pos,
            null,
            {
                ...node.attrs,
                alignment: item.alignment,
            },
        )
        view.dispatch(tr)
        view.focus()
    })

    return button
}

const createImageWrapButton = (
    item: ImageWrapItem,
    bubbleMenuView: BubbleMenuView,
): HTMLElement => {
    const button = createEl(
        'button',
        {
            className: 'bubble-menu-button',
            type: 'button',
            'aria-label': item.title,
            innerHTML: item.icon,
            data: {
                helpTooltip: 'aria-label',
                imageWrap: item.wrap,
            },
        },
    )

    const svg = button.querySelector('svg')

    if (svg)
        applyStyle(
            svg,
            {
                width: `${item.iconSize}px`,
                height: `${item.iconSize}px`,
            },
        )

    button.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()

        const view = bubbleMenuView.getView()
        const imageInfo = getSelectedImageNode(view)

        if (!imageInfo)
            return

        const {
            pos,
            node,
        } = imageInfo
        const tr = view.state.tr.setNodeMarkup(
            pos,
            null,
            {
                ...node.attrs,
                textWrap: item.wrap,
            },
        )
        view.dispatch(tr)
        view.focus()
    })

    return button
}

const createImageActionButton = (
    item: ImageActionItem,
    bubbleMenuView: BubbleMenuView,
    auth?: AuthTokenProvider,
): HTMLElement => {
    const button = createEl(
        'button',
        {
            className: 'bubble-menu-button',
            type: 'button',
            'aria-label': item.title,
            innerHTML: item.icon,
            data: {
                helpTooltip: 'aria-label',
                imageAction: item.action,
            },
        },
    )

    const svg = button.querySelector('svg')

    if (svg)
        applyStyle(
            svg,
            {
                width: `${item.iconSize}px`,
                height: `${item.iconSize}px`,
            },
        )

    button.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()

        const view = bubbleMenuView.getView()
        const imageInfo = getSelectedImageNode(view)

        if (!imageInfo)
            return

        const {
            pos,
            node,
        } = imageInfo

        switch (item.action) {
            case 'download': {
                const domNode = view.nodeDOM(pos)
                const imgEl = domNode instanceof HTMLElement
                    ? domNode.querySelector('img') as HTMLImageElement | null
                    : null

                if (imgEl?.src)
                    downloadImage(imgEl.src, { getAuthToken: () => auth?.getTokenSilently() ?? Promise.resolve(false) })

                bubbleMenuView.forceHide()

                break
            }
            case 'createVariant': {
                // Check if image has AI-related attrs (is an AI-generated image)
                if (
                    node.attrs.revisedPrompt
                    || node.attrs.responseId
                ) {
                    view.dom.dispatchEvent(
                        new CustomEvent(
                            'create-ai-image-variant',
                            {
                                detail: {
                                    node,
                                    pos,
                                },
                                bubbles: true,
                            },
                        ),
                    )
                }

                bubbleMenuView.forceHide()

                break
            }
            case 'delete': {
                const tr = view.state.tr.delete(pos, pos + node.nodeSize)
                view.dispatch(tr)
                view.focus()
                bubbleMenuView.forceHide()

                break
            }
            case 'blockquote': {
                const { schema } = view.state
                const blockquoteType = schema.nodes.blockquote

                if (!blockquoteType)
                    return

                const blockquote = blockquoteType.create(null, node)
                const tr = view.state.tr.replaceWith(
                    pos,
                    pos + node.nodeSize,
                    blockquote,
                )
                view.dispatch(tr)
                view.focus()

                break
            }
        }
    })

    return button
}

const createLinkInputPanel = (
    view: EditorView,
    bubbleMenuView: BubbleMenuView,
): HTMLElement => {
    const input = createEl(
        'input',
        {
            type: 'url',
            placeholder: 'URL...',
            className: 'link-input-field',
        },
    ) as HTMLInputElement

    const applyIcon = createEl(
        'span',
        {
            className: 'link-input-apply',
            innerHTML: checkMarkIcon,
            role: 'button',
            tabindex: '0',
            'aria-label': 'Apply link',
            data: { helpTooltip: 'aria-label' },
        },
    )

    const removeIcon = createEl(
        'span',
        {
            className: 'link-input-remove',
            innerHTML: trashBinIcon,
            role: 'button',
            tabindex: '0',
            'aria-label': 'Remove link',
            data: { helpTooltip: 'aria-label' },
        },
    )

    applyIcon.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        bubbleMenuView.applyLink(input.value)
    })
    applyIcon.addEventListener('keydown', e => {
        if (
            e.key !== 'Enter'
            && e.key !== ' '
        )
            return

        e.preventDefault()
        e.stopPropagation()
        bubbleMenuView.applyLink(input.value)
    })

    removeIcon.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        bubbleMenuView.removeLink()
    })
    removeIcon.addEventListener('keydown', e => {
        if (
            e.key !== 'Enter'
            && e.key !== ' '
        )
            return

        e.preventDefault()
        e.stopPropagation()
        bubbleMenuView.removeLink()
    })

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault()
            bubbleMenuView.applyLink(input.value)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            bubbleMenuView.closeLinkInput()
            view.focus()
        }
    })

    return createEl(
        'div',
        { className: 'bubble-menu-link-input' },
        input,
        applyIcon,
        removeIcon,
    )
}

// =============================================================================
// MAIN BUILDER FUNCTION
// =============================================================================

export type MenuItemElement = BubbleMenuItem & {
    context: SelectionContext[]
}

export const buildBubbleMenuItems = (
    view: EditorView,
    bubbleMenuView: BubbleMenuView,
    auth?: AuthTokenProvider,
): {
    items: MenuItemElement[]
    linkInputPanel: HTMLElement
} => {
    const { schema } = view.state
    const items: MenuItemElement[] = []

    for (const item of MENU_ITEMS) {
        switch (item.type) {
            case 'separator':
                items.push({
                    element: createSeparator(),
                    context: item.context,
                })

                break
            case 'dropdown': {
                const {
                    element,
                    update,
                } = createDropdown(item, view)
                items.push({
                    element,
                    context: item.context,
                    update,
                })

                break
            }
            case 'mark': {
                const cmd = getMarkCommand(schema, item.mark)
                const btn = createButton(
                    item,
                    cmd,
                    view,
                    bubbleMenuView,
                    item.mark,
                )

                if (btn)
                    items.push({
                        element: btn,
                        context: item.context,
                    })

                break
            }
            case 'block': {
                const cmd = getBlockCommand(schema, item.node)
                const btn = createButton(
                    item,
                    cmd,
                    view,
                    bubbleMenuView,
                )

                if (btn)
                    items.push({
                        element: btn,
                        context: item.context,
                    })

                break
            }
            case 'blockWrap': {
                const cmd = getBlockWrapCommand(schema, item.node)
                const btn = createButton(
                    item,
                    cmd,
                    view,
                    bubbleMenuView,
                )

                if (btn)
                    items.push({
                        element: btn,
                        context: item.context,
                    })

                break
            }
            case 'imageAlignment': {
                const btn = createImageAlignmentButton(item, bubbleMenuView)
                items.push({
                    element: btn,
                    context: item.context,
                })

                break
            }
            case 'imageWrap': {
                const btn = createImageWrapButton(item, bubbleMenuView)
                items.push({
                    element: btn,
                    context: item.context,
                })

                break
            }
            case 'imageAction': {
                const btn = createImageActionButton(
                    item,
                    bubbleMenuView,
                    auth,
                )
                items.push({
                    element: btn,
                    context: item.context,
                })

                break
            }
        }
    }

    return {
        items,
        linkInputPanel: createLinkInputPanel(view, bubbleMenuView),
    }
}

export const updateImageButtonStates = (
    items: MenuItemElement[],
    view: EditorView,
): void => {
    const imageInfo = getSelectedImageNode(view)

    if (!imageInfo)
        return

    const { node } = imageInfo
    const alignment = node.attrs.alignment || 'left'
    const textWrap = node.attrs.textWrap || 'none'

    for (const item of items) {
        if (!item.context.includes('image'))
            continue

        const el = item.element
        const alignmentAttr = el.dataset?.imageAlignment
        const wrapAttr = el.dataset?.imageWrap

        if (alignmentAttr)
            el.classList.toggle('is-active', alignmentAttr === alignment)

        if (wrapAttr)
            el.classList.toggle('is-active', wrapAttr === textWrap)
    }
}
