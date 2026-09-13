import { select } from 'd3-selection'
import {
    type PromptReferenceCatalogItem,
    type PromptReferenceCategory,
} from '@lixpi/constants'
import { PROMPT_REFERENCE_NODE_TYPE } from '@lixpi/prosemirror'
import {
    Plugin,
    PluginKey,
    type Transaction,
} from 'prosemirror-state'
import {
    type EditorView,
} from 'prosemirror-view'

import {
    createSlidingSwitch,
    type SlidingSwitchInstance,
} from '@lixpi/ui-kit/components/sliding-switch'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import {
    type PromptReferenceCatalogClient,
} from '$src/services/prompt-reference-catalog-client.ts'
import {
    getTransformedAncestorScale,
    resolveFloatingMenuScreenPosition,
    screenPointToLocal,
    type FloatingMenuPlacement,
} from '$src/components/proseMirror/plugins/floatingMenuPosition.ts'
import {
    applyStyle,
    html,
} from '@lixpi/ui-primitives/dom'
import { resolveAuthenticatedMediaUrl } from '$src/utils/mediaUrls.ts'
import {
    capabilityArtifactFrontendRegistry,
    ensureCapabilityStyles,
    getCapabilityArtifactIcon,
} from '$src/installed-capabilities.ts'

export type PromptReferencePickerMode = 'references' | 'modules'

export type PromptReferencePickerState = {
    active: boolean
    triggerPos: number
    query: string
    selectedIndex: number
    category: PromptReferenceCategory
}

export const promptReferenceCatalogItemToAtomAttrs = (item: PromptReferenceCatalogItem): Record<string, string> => {
    if (item.referenceType === 'media') {
        return {
            referenceType: 'media',
            assetId: item.assetId,
            nodeId: item.nodeId ?? '',
            mediaKind: item.mediaKind,
            displayName: item.title,
        }
    }

    if (item.referenceType === 'capability-artifact') {
        return {
            referenceType: 'capability-artifact',
            assetId: item.assetId,
            nodeId: item.nodeId ?? '',
            artifactTypeId: item.artifactTypeId,
            displayName: item.title,
        }
    }

    if (item.referenceType === 'capability-module') {
        return {
            referenceType: 'capability-module',
            moduleId: item.moduleId,
            displayName: item.name,
        }
    }

    return {
        referenceType: item.referenceType,
        capabilityId: item.capabilityId,
        displayName: item.name,
    }
}

const getCatalogItemKey = (item: PromptReferenceCatalogItem): string => {
    if (item.referenceType === 'media')
        return `media:${item.assetId}:${item.nodeId ?? ''}`

    if (item.referenceType === 'capability-artifact')
        return `capability-artifact:${item.assetId}:${item.nodeId ?? ''}`

    return `${item.referenceType}:${item.referenceId}`
}

const getCatalogItemSignature = (item: PromptReferenceCatalogItem): string => {
    if (item.referenceType === 'media') {
        return [
            item.title,
            item.source,
            item.scope,
            item.mediaKind,
            String(item.thumbnailAvailable),
            String(item.updatedAt),
        ].join('\n')
    }

    if (item.referenceType === 'capability-artifact') {
        return [
            item.title,
            item.source,
            item.scope,
            item.artifactTypeId,
            JSON.stringify(item.displayMetadata),
            String(item.updatedAt),
        ].join('\n')
    }

    return [item.name, item.summary, item.referenceType].join('\n')
}

const categoryLabel = (category: PromptReferenceCategory): string => {
    if (category === 'capabilities')
        return 'Capabilities'

    return `${category[0]!.toLocaleUpperCase('en-US')}${category.slice(1)}`
}

export const promptReferencePickerPluginKey = new PluginKey<PromptReferencePickerState>('promptReferencePicker')
export const capabilityModulePickerPluginKey = new PluginKey<PromptReferencePickerState>('capabilityModulePicker')

const SEARCH_DEBOUNCE_MS = 150
const PAGE_LIMIT = 20
const REFERENCE_CATEGORIES: Array<{
    label: string
    value: PromptReferenceCategory
}> = [
    {
        label: 'Media',
        value: 'media',
    },
    {
        label: 'Artifacts',
        value: 'artifacts',
    },
    {
        label: 'Capabilities',
        value: 'capabilities',
    },
    {
        label: 'Tools',
        value: 'tools',
    },
    {
        label: 'Skills',
        value: 'skills',
    },
]

const initialState = (mode: PromptReferencePickerMode): PromptReferencePickerState => ({
    active: false,
    triggerPos: -1,
    query: '',
    selectedIndex: 0,
    category: mode === 'modules' ? 'capabilities' : 'media',
})

export const reducePromptReferencePickerState = (
    tr: Transaction,
    state: PromptReferencePickerState,
    key: PluginKey<PromptReferencePickerState>,
    mode: PromptReferencePickerMode,
): PromptReferencePickerState => {
    const meta = tr.getMeta(key)

    if (meta?.type === 'open')
        return {
            ...initialState(mode),
            active: true,
            triggerPos: meta.triggerPos,
        }

    if (meta?.type === 'close')
        return initialState(mode)

    if (meta?.type === 'select')
        return {
            ...state,
            selectedIndex: meta.selectedIndex,
        }

    if (
        meta?.type === 'category'
        && mode === 'references'
    )
        return {
            ...state,
            category: meta.category,
            selectedIndex: 0,
        }

    if (!state.active)
        return state

    const triggerPos = tr.mapping.map(state.triggerPos)
    const cursorPos = tr.selection.from

    if (
        !tr.selection.empty
        || cursorPos <= triggerPos
    )
        return initialState(mode)

    const query = tr.doc.textBetween(
        triggerPos + 1,
        cursorPos,
        ' ',
    )

    if (
        /\s/.test(query)
        || query.length > 80
    )
        return initialState(mode)

    return {
        ...state,
        triggerPos,
        query,
        selectedIndex: query === state.query ? state.selectedIndex : 0,
    }
}

export const nextPromptReferencePickerIndex = (
    selectedIndex: number,
    direction: 'next' | 'previous',
    resultCount: number,
): number => {
    if (resultCount <= 0)
        return 0

    const delta = direction === 'next' ? 1 : -1

    return (selectedIndex + delta + resultCount) % resultCount
}

class PromptReferencePickerMenu {
    private readonly menu: HTMLDivElement
    private readonly list: HTMLDivElement
    private readonly categorySwitch: SlidingSwitchInstance<PromptReferenceCategory> | null
    private readonly rowCache = new Map<string, {
        element: HTMLButtonElement
        signature: string
    }>()
    private results: PromptReferenceCatalogItem[] = []
    private cursor: string | undefined
    private loading = false
    private menuVisible = false
    private positionedTriggerPos: number | null = null
    private menuPlacement: FloatingMenuPlacement | null = null
    private activeCategory: PromptReferenceCategory | null = null
    private requestSequence = 0
    private lastRequestKey: string | null = null
    private searchTimer: ReturnType<typeof setTimeout> | undefined

    private readonly handleWheel = (event: WheelEvent): void => void event.stopPropagation()

    private readonly handleDocumentMouseDown = (event: MouseEvent): void => {
        const state = this.key.getState(this.view.state)

        if (
            !state?.active
            || event.composedPath().includes(this.menu)
        )
            return

        this.close()
    }

    constructor(
        private readonly auth: AuthTokenProvider,
        private readonly view: EditorView,
        private readonly catalog: PromptReferenceCatalogClient,
        private readonly mode: PromptReferencePickerMode,
        private readonly key: PluginKey<PromptReferencePickerState>,
    ) {
        this.list = html`<div className="prompt-reference-picker-list"></div>` as HTMLDivElement
        const header = mode === 'references'
            ? html`<div className="prompt-reference-picker-header"></div>` as HTMLDivElement
            : null
        const switchSvg = header
            ? select(header)
                .append('svg')
                .attr('class', 'prompt-reference-picker-switch')
                .attr('width', 416)
                .attr('height', 32)
                .attr('viewBox', '0 0 416 32')
                .attr('aria-label', 'Reference category')
                .node() as SVGSVGElement
            : null
        this.menu = html`
            <div
                className=${`prompt-reference-picker prompt-reference-picker-${mode} nopan nowheel`}
                role="listbox"
                aria-label=${mode === 'modules' ? 'Capabilities' : 'Prompt references'}
                contenteditable="false"
                onwheel=${this.handleWheel}
                style=${{ display: 'none' }}
            >
                ${header}
                ${this.list}
            </div>
        ` as HTMLDivElement
        this.view.dom.parentElement?.appendChild(this.menu)
        this.categorySwitch = switchSvg
            ? createSlidingSwitch(
                select(switchSvg),
                {
                    id: 'prompt-reference-category',
                    x: 0,
                    y: 2,
                    width: 416,
                    height: 28,
                    options: REFERENCE_CATEGORIES,
                    selectedValue: 'media',
                    role: 'radiogroup',
                    optionRole: 'radio',
                    selectedAriaAttribute: 'aria-checked',
                    onChange: category => this.changeCategory(category),
                },
            )
            : null
        this.menu.ownerDocument.addEventListener(
            'mousedown',
            this.handleDocumentMouseDown,
            true,
        )
    }

    update(): void {
        const state = this.key.getState(this.view.state)

        if (
            !state?.active
            || !this.view.editable
        ) {
            this.hide()

            return
        }

        this.categorySwitch?.setValue(state.category)
        const categoryChanged = this.activeCategory !== null && this.activeCategory !== state.category
        this.activeCategory = state.category
        const requestKey = `${state.category}\n${state.query}`

        if (requestKey !== this.lastRequestKey) {
            this.lastRequestKey = requestKey
            this.loadFirstPage(
                state.category,
                state.query,
                categoryChanged,
            )
        }

        this.updateSelection(state.selectedIndex)

        if (this.menuVisible)
            this.show(state.triggerPos, categoryChanged)
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        const state = this.key.getState(this.view.state)

        if (!state?.active)
            return false

        if (event.key === 'Escape') {
            event.preventDefault()
            this.close()

            return true
        }

        if (
            this.loading
            && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)
        ) {
            event.preventDefault()

            return true
        }

        if (
            event.key === 'ArrowDown'
            || event.key === 'ArrowUp'
        ) {
            event.preventDefault()

            if (
                event.key === 'ArrowDown'
                && state.selectedIndex === this.results.length - 1
                && this.cursor
            ) {
                void this.loadMore(state.category, state.query)

                return true
            }

            const selectedIndex = nextPromptReferencePickerIndex(
                state.selectedIndex,
                event.key === 'ArrowDown' ? 'next' : 'previous',
                this.results.length,
            )
            this.view.dispatch(
                this.view.state.tr.setMeta(
                    this.key,
                    {
                        type: 'select',
                        selectedIndex,
                    },
                ),
            )

            return true
        }

        if (
            (event.key === 'Enter' || event.key === 'Tab')
            && this.results[state.selectedIndex]
        ) {
            event.preventDefault()
            this.insert(this.results[state.selectedIndex])

            return true
        }

        return false
    }

    destroy(): void {
        this.cancelPendingSearch()
        this.menu.ownerDocument.removeEventListener(
            'mousedown',
            this.handleDocumentMouseDown,
            true,
        )
        this.categorySwitch?.destroy()
        this.menu.remove()
    }

    private changeCategory(category: PromptReferenceCategory): void {
        const state = this.key.getState(this.view.state)

        if (
            !state?.active
            || state.category === category
        )
            return

        this.view.dispatch(
            this.view.state.tr.setMeta(
                this.key,
                {
                    type: 'category',
                    category,
                },
            ),
        )
    }

    private loadFirstPage(
        category: PromptReferenceCategory,
        query: string,
        categoryChanged: boolean,
    ): void {
        this.cancelPendingSearch()
        this.loading = true
        this.cursor = undefined
        this.menu.ariaBusy = 'true'

        if (
            !this.menuVisible
            || categoryChanged
        ) {
            this.results = []
            this.list.replaceChildren(html`
                <div
                    className="prompt-reference-picker-status"
                    role="status"
                >Searching…</div>
            `)
        }

        const requestSequence = ++this.requestSequence
        this.searchTimer = setTimeout(
            () => {
                this.searchTimer = undefined
                void this.executeList({
                    category,
                    query,
                    requestSequence,
                    append: false,
                })
            },
            SEARCH_DEBOUNCE_MS,
        )
    }

    private async loadMore(
        category: PromptReferenceCategory,
        query: string,
    ): Promise<void> {
        if (!this.cursor)
            return

        const requestSequence = ++this.requestSequence
        await this.executeList({
            category,
            query,
            requestSequence,
            append: true,
            cursor: this.cursor,
        })
    }

    private async executeList({
        category,
        query,
        requestSequence,
        append,
        cursor,
    }: {
        category: PromptReferenceCategory
        query: string
        requestSequence: number
        append: boolean
        cursor?: string
    }): Promise<void> {
        try {
            const page = await this.catalog.list({
                category,
                query,
                cursor,
                limit: PAGE_LIMIT,
            })
            const state = this.key.getState(this.view.state)

            if (
                requestSequence !== this.requestSequence
                || !state?.active
                || state.category !== category
                || state.query !== query
            )
                return

            if (!append) {
                this.loading = false
                this.menu.ariaBusy = null
            }

            const existingKeys = new Set(
                this.results.map(getCatalogItemKey),
            )
            this.results = append
                ? [...this.results, ...page.items.filter(
                    item => !existingKeys.has(
                        getCatalogItemKey(item),
                    ),
                )]
                : page.items
            this.cursor = page.cursor
            this.render(state.selectedIndex)
            this.show(state.triggerPos, true)
        } catch {
            if (requestSequence !== this.requestSequence)
                return

            const state = this.key.getState(this.view.state)

            if (
                !state?.active
                || state.category !== category
                || state.query !== query
            )
                return

            if (!append) {
                this.loading = false
                this.menu.ariaBusy = null
            }

            this.results = []
            this.cursor = undefined
            this.list.replaceChildren(
                html`
                    <div
                        className="prompt-reference-picker-status"
                        role="status"
                    >Could not load ${categoryLabel(category)}.</div>
                `,
            )
            this.show(state.triggerPos, true)
        }
    }

    private render(selectedIndex: number): void {
        const state = this.key.getState(this.view.state)

        if (!state)
            return

        if (this.results.length === 0) {
            this.rowCache.clear()
            this.list.replaceChildren(
                html`
                    <div
                        className="prompt-reference-picker-status"
                        role="status"
                    >No matching ${categoryLabel(state.category)}.</div>
                `,
            )

            return
        }

        const currentKeys = new Set<string>()
        const rows = this.results.map(item => {
            const itemKey = getCatalogItemKey(item)
            const signature = getCatalogItemSignature(item)
            currentKeys.add(itemKey)
            const cached = this.rowCache.get(itemKey)

            if (cached?.signature === signature)
                return cached.element

            const element = this.renderRow(item, itemKey)
            this.rowCache.set(
                itemKey,
                {
                    element,
                    signature,
                },
            )

            return element
        })

        for (const itemKey of this.rowCache.keys()) {
            if (!currentKeys.has(itemKey))
                this.rowCache.delete(itemKey)
        }

        if (this.cursor) {
            const loadMore = html`
                <button
                    type="button"
                    className="prompt-reference-picker-load-more"
                    onmousedown=${(event: MouseEvent) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void this.loadMore(state.category, state.query)
                    }}
                >Load more</button>
            ` as HTMLButtonElement
            rows.push(loadMore)
        }

        this.list.replaceChildren(...rows)
        this.updateSelection(selectedIndex)
    }

    private renderRow(
        item: PromptReferenceCatalogItem,
        itemKey: string,
    ): HTMLButtonElement {
        if (item.referenceType === 'capability-artifact')
            return this.renderArtifactRow(item, itemKey)

        const media = item.referenceType === 'media'
        const label = media ? item.title : item.name
        const summary = media
            ? `${item.source === 'canvas' ? 'Canvas placement' : 'Library Asset'} · ${item.scope}`
            : item.summary
        const badge = item.referenceType === 'media'
            ? item.mediaKind
            : item.referenceType === 'capability-module'
                ? 'Capability'
                : item.referenceType
        const thumbnail = media
            && item.thumbnailAvailable
            ? html`
                <img
                    className="prompt-reference-picker-thumbnail"
                    alt=""
                />
            `
            : html`<span className=${`prompt-reference-picker-glyph prompt-reference-picker-glyph-${item.referenceType}`}>${badge.slice(0, 1)}</span>`

        if (thumbnail instanceof HTMLImageElement) {
            const rendition = item.referenceType === 'media'
                && item.mediaKind === 'video'
                ? 'representativeFrame'
                : 'thumbnail'
            const loadThumbnail = async (): Promise<void> => {
                try {
                    const url = await resolveAuthenticatedMediaUrl(
                        `/api/assets/${encodeURIComponent(item.referenceId)}/renditions/${rendition}`,
                        {
                            apiBaseUrl: import.meta.env.VITE_API_URL || '',
                            getAuthToken: () => this.auth.getTokenSilently(),
                        },
                    )

                    if (url)
                        thumbnail.src = url
                } catch {
                    // The picker keeps the empty thumbnail when its rendition is unavailable.
                }
            }
            void loadThumbnail()
        }

        return html`
            <button
                type="button"
                className="prompt-reference-picker-item"
                role="option"
                aria-selected="false"
                data-help-tooltip="aria-label"
                aria-label=${`${label}: ${summary}`}
                onmousedown=${(event: MouseEvent) => {
                    event.preventDefault()
                    event.stopPropagation()

                    if (this.loading)
                        return

                    const currentItem = this.results.find(result => getCatalogItemKey(result) === itemKey)

                    if (currentItem)
                        this.insert(currentItem)
                }}
                onmousemove=${() => {
                    if (this.loading)
                        return

                    const current = this.key.getState(this.view.state)
                    const index = this.results.findIndex(result => getCatalogItemKey(result) === itemKey)

                    if (
                        current?.active
                        && current.selectedIndex !== index
                    )
                        this.view.dispatch(
                            this.view.state.tr.setMeta(
                                this.key,
                                {
                                    type: 'select',
                                    selectedIndex: index,
                                },
                            ),
                        )
                }}
            >
                ${thumbnail}
                <span className="prompt-reference-picker-copy">
                    <strong>${label}</strong>
                    <small>${summary}</small>
                </span>
                <span className=${`prompt-reference-picker-badge prompt-reference-picker-badge-${item.referenceType}`}>${badge}</span>
            </button>
        ` as HTMLButtonElement
    }

    private renderArtifactRow(
        item: Extract<PromptReferenceCatalogItem, { referenceType: 'capability-artifact' }>,
        itemKey: string,
    ): HTMLButtonElement {
        ensureCapabilityStyles(this.menu.ownerDocument)
        const row = html`
            <button
                type="button"
                className="prompt-reference-picker-item prompt-reference-picker-item-capability-artifact"
                role="option"
                aria-selected="false"
                data-help-tooltip="aria-label"
                aria-label=${item.title}
                onmousedown=${(event: MouseEvent) => {
                    event.preventDefault()
                    event.stopPropagation()

                    if (this.loading)
                        return

                    const currentItem = this.results.find(result => getCatalogItemKey(result) === itemKey)

                    if (currentItem)
                        this.insert(currentItem)
                }}
                onmousemove=${() => {
                    if (this.loading)
                        return

                    const current = this.key.getState(this.view.state)
                    const index = this.results.findIndex(result => getCatalogItemKey(result) === itemKey)

                    if (
                        current?.active
                        && current.selectedIndex !== index
                    )
                        this.view.dispatch(
                            this.view.state.tr.setMeta(
                                this.key,
                                {
                                    type: 'select',
                                    selectedIndex: index,
                                },
                            ),
                        )
                }}
            >
                <span
                    className="prompt-reference-picker-glyph prompt-reference-picker-glyph-capability-artifact"
                    aria-hidden="true"
                    innerHTML=${getCapabilityArtifactIcon(item.artifactTypeId)}
                ></span>
                <span className="prompt-reference-picker-copy prompt-reference-picker-artifact-host"></span>
                <span className="prompt-reference-picker-badge">Artifact</span>
            </button>
        ` as HTMLButtonElement
        capabilityArtifactFrontendRegistry.require(item.artifactTypeId).createPromptReferenceView({
            container: row.querySelector('.prompt-reference-picker-artifact-host') as HTMLElement,
            title: item.title,
            displayMetadata: item.displayMetadata,
        })

        return row
    }

    private updateSelection(selectedIndex: number): void {
        const rows = this.list.querySelectorAll<HTMLElement>('.prompt-reference-picker-item')
        rows.forEach((row, index) => {
            const selected = index === selectedIndex
            row.classList.toggle('is-selected', selected)
            row.ariaSelected = String(selected)
        })
    }

    private insert(item: PromptReferenceCatalogItem): void {
        const state = this.key.getState(this.view.state)
        const nodeType = this.view.state.schema.nodes[PROMPT_REFERENCE_NODE_TYPE]

        if (
            !state?.active
            || !nodeType
        )
            return

        const atom = nodeType.create(
            promptReferenceCatalogItemToAtomAttrs(item),
        )
        const tr = this.view.state.tr
            .replaceWith(
                state.triggerPos,
                this.view.state.selection.from,
                atom,
            )
            .insertText(' ')
            .setMeta(this.key, { type: 'close' })
            .scrollIntoView()
        this.view.dispatch(tr)
        this.view.focus()
    }

    private close(): void {
        this.view.dispatch(
            this.view.state.tr.setMeta(this.key, { type: 'close' }),
        )
    }

    private show(
        triggerPos: number,
        forcePosition = false,
    ): void {
        this.menu.classList.add('prompt-reference-picker-visible')
        this.menu.style.display = 'flex'

        if (
            this.menuVisible
            && this.positionedTriggerPos === triggerPos
            && !forcePosition
        )
            return

        const coords = this.view.coordsAtPos(triggerPos)
        const parent = this.menu.parentElement
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
        }
        const scale = getTransformedAncestorScale(parent)
        const positionOptions = this.menuPlacement === null
            ? {}
            : { preferredPlacement: this.menuPlacement }
        const screenPosition = resolveFloatingMenuScreenPosition(
            coords,
            this.menu.getBoundingClientRect(),
            {
                width: window.innerWidth,
                height: window.innerHeight,
            },
            6 * scale,
            positionOptions,
        )
        const localPosition = screenPointToLocal(
            parentRect,
            screenPosition,
            scale,
        )
        applyStyle(
            this.menu,
            {
                display: 'flex',
                left: `${localPosition.left}px`,
                top: `${localPosition.top}px`,
            },
        )
        this.menu.dataset.placement = screenPosition.placement
        this.menuPlacement = screenPosition.placement
        this.menuVisible = true
        this.positionedTriggerPos = triggerPos
    }

    private hide(): void {
        this.cancelPendingSearch()
        this.lastRequestKey = null
        this.results = []
        this.cursor = undefined
        this.loading = false
        this.menuVisible = false
        this.positionedTriggerPos = null
        this.menuPlacement = null
        this.activeCategory = null
        this.menu.ariaBusy = null
        this.menu.classList.remove('prompt-reference-picker-visible')
        this.menu.style.display = 'none'
    }

    private cancelPendingSearch(): void {
        this.requestSequence += 1

        if (this.searchTimer !== undefined) {
            clearTimeout(this.searchTimer)
            this.searchTimer = undefined
        }
    }
}

const createPromptReferencePickerPlugin = (
    auth: AuthTokenProvider,
    catalog: PromptReferenceCatalogClient,
    mode: PromptReferencePickerMode,
): Plugin<PromptReferencePickerState> => {
    const key = mode === 'modules' ? capabilityModulePickerPluginKey : promptReferencePickerPluginKey
    const trigger = mode === 'modules' ? '/' : '@'
    let menu: PromptReferencePickerMenu | null = null

    return new Plugin<PromptReferencePickerState>({
        key,
        state: {
            init: () => initialState(mode),
            apply: (tr, state) => reducePromptReferencePickerState(
                tr,
                state,
                key,
                mode,
            ),
        },
        props: {
            handleTextInput(
                view,
                from,
                to,
                text,
            ) {
                if (text !== trigger)
                    return false

                const { $from } = view.state.selection

                if ($from.parent.type.name === 'code_block')
                    return false

                const characterBefore = from > 0 ? view.state.doc.textBetween(
                    from - 1,
                    from,
                    '',
                ) : ''

                if (
                    $from.parentOffset !== 0
                    && !/\s/.test(characterBefore)
                )
                    return false

                view.dispatch(
                    view.state.tr
                        .insertText(
                            trigger,
                            from,
                            to,
                        )
                        .setMeta(
                            key,
                            {
                                type: 'open',
                                triggerPos: from,
                            },
                        ),
                )

                return true
            },
            handleKeyDown: (_view, event) => menu?.handleKeyDown(event) ?? false,
        },
        view(editorView) {
            menu = new PromptReferencePickerMenu(
                auth,
                editorView,
                catalog,
                mode,
                key,
            )

            return {
                update: () => menu?.update(),
                destroy: () => {
                    menu?.destroy()
                    menu = null
                },
            }
        },
    })
}

export const createAtPromptReferencePickerPlugin = (
    auth: AuthTokenProvider,
    catalog: PromptReferenceCatalogClient,
): Plugin => createPromptReferencePickerPlugin(
    auth,
    catalog,
    'references',
)

export const createSlashCapabilityModulePickerPlugin = (
    auth: AuthTokenProvider,
    catalog: PromptReferenceCatalogClient,
): Plugin => createPromptReferencePickerPlugin(
    auth,
    catalog,
    'modules',
)
