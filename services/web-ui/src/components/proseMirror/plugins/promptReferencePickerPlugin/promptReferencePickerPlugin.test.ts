import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    type PromptReferenceCatalogItem,
    type PromptReferenceCatalogPage,
} from '@lixpi/constants'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import { testSchema } from '$src/components/proseMirror/plugins/testUtils/testSchema.ts'
import {
    capabilityModulePickerPluginKey,
    createAtPromptReferencePickerPlugin,
    createSlashCapabilityModulePickerPlugin,
    nextPromptReferencePickerIndex,
    promptReferenceCatalogItemToAtomAttrs,
    promptReferencePickerPluginKey,
} from './promptReferencePickerPlugin.ts'

const catalog = {
    list: async () => ({ items: [] }),
    listModules: async () => [],
    getModule: async () => {
        throw new Error('not used')
    },
}
const auth = { getTokenSilently: vi.fn(async () => 'token-1') }

afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
})

const createPromptState = (plugin: ReturnType<typeof createAtPromptReferencePickerPlugin>): EditorState => {
    const paragraph = testSchema.nodes.paragraph.create()
    const prompt = testSchema.nodes.aiPromptInput.create(null, [paragraph])

    return EditorState.create({
        schema: testSchema,
        doc: testSchema.nodes.doc.create(null, [prompt]),
        plugins: [plugin],
    })
}

describe('promptReferencePickerPlugin', () => {
    it('defaults each @ session to Media and retains the query while switching categories', () => {
        const plugin = createAtPromptReferencePickerPlugin(auth, catalog)
        let state = createPromptState(plugin)
        state = state.apply(
            state.tr.insertText('@').setMeta(promptReferencePickerPluginKey, {
                type: 'open',
                triggerPos: state.selection.from,
            }),
        )
        state = state.apply(state.tr.insertText('por'))
        state = state.apply(state.tr.setMeta(promptReferencePickerPluginKey, {
            type: 'category',
            category: 'tools',
        }))

        expect(promptReferencePickerPluginKey.getState(state)).toMatchObject({
            active: true,
            category: 'tools',
            query: 'por',
        })

        state = state.apply(state.tr.setMeta(promptReferencePickerPluginKey, { type: 'close' }))
        expect(promptReferencePickerPluginKey.getState(state)).toMatchObject({
            active: false,
            category: 'media',
            query: '',
        })
    })

    it('hard-locks the slash picker to Capability modules', () => {
        const plugin = createSlashCapabilityModulePickerPlugin(auth, catalog)
        let state = createPromptState(plugin)
        state = state.apply(state.tr.setMeta(capabilityModulePickerPluginKey, {
            type: 'open',
            triggerPos: state.selection.from,
        }))
        state = state.apply(state.tr.setMeta(capabilityModulePickerPluginKey, {
            type: 'category',
            category: 'skills',
        }))

        expect(capabilityModulePickerPluginKey.getState(state)?.category).toBe('capabilities')
    })

    it('keeps wheel scrolling inside the picker instead of bubbling to the canvas', () => {
        const plugin = createAtPromptReferencePickerPlugin(auth, catalog)
        const mount = document.createElement('div')
        document.body.appendChild(mount)
        const canvasWheelHandler = vi.fn()
        mount.addEventListener('wheel', canvasWheelHandler)
        const view = new EditorView(mount, { state: createPromptState(plugin) })
        const listbox = mount.querySelector<HTMLElement>('[role="listbox"]')

        if (!listbox)
            throw new Error('Expected prompt reference listbox')

        const wheelEvent = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: 120,
        })

        expect(listbox.classList.contains('nopan')).toBe(true)
        expect(listbox.classList.contains('nowheel')).toBe(true)
        listbox.dispatchEvent(wheelEvent)

        expect(canvasWheelHandler).not.toHaveBeenCalled()
        expect(wheelEvent.defaultPrevented).toBe(false)

        view.destroy()
    })

    it.each(
        [
            ['@', createAtPromptReferencePickerPlugin, promptReferencePickerPluginKey],
            ['/', createSlashCapabilityModulePickerPlugin, capabilityModulePickerPluginKey],
        ] as const,
    )('closes the %s picker only when pressing outside it', async (trigger, createPlugin, pluginKey) => {
        vi.useFakeTimers()
        const plugin = createPlugin(auth, catalog)
        const mount = document.createElement('div')
        const outside = document.createElement('button')
        document.body.append(mount, outside)
        const view = new EditorView(mount, { state: createPromptState(plugin) })
        const triggerPos = view.state.selection.from
        view.dispatch(
            view.state.tr
                .insertText(trigger)
                .setMeta(pluginKey, {
                    type: 'open',
                    triggerPos,
                }),
        )
        await vi.advanceTimersByTimeAsync(150)

        const listbox = mount.querySelector<HTMLElement>('[role="listbox"]')

        if (!listbox)
            throw new Error(`Expected ${trigger} picker listbox`)

        expect(listbox.style.display).toBe('flex')

        listbox.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        }))
        expect(pluginKey.getState(view.state)?.active).toBe(true)

        outside.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        }))
        expect(pluginKey.getState(view.state)?.active).toBe(false)
        expect(listbox.style.display).toBe('none')

        view.dispatch(view.state.tr.setMeta(pluginKey, {
            type: 'open',
            triggerPos,
        }))
        const dispatchSpy = vi.spyOn(view, 'dispatch')
        view.destroy()
        dispatchSpy.mockClear()

        outside.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        }))
        expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('wraps keyboard selection in both directions', () => {
        expect(nextPromptReferencePickerIndex(2, 'next', 3)).toBe(0)
        expect(nextPromptReferencePickerIndex(0, 'previous', 3)).toBe(2)
        expect(nextPromptReferencePickerIndex(0, 'next', 0)).toBe(0)
    })

    it('maps registered Artifact rows to generic prompt-reference attrs', () => {
        expect(promptReferenceCatalogItemToAtomAttrs({
            referenceType: 'capability-artifact',
            referenceId: 'artifact-1',
            assetId: 'artifact-1',
            nodeId: 'node-1',
            artifactTypeId: 'action-timeline',
            source: 'canvas',
            title: 'Action Timeline',
            scope: 'workspace',
            updatedAt: 1,
            displayMetadata: { segmentCount: 3 },
            referenceThumbnailAssetIds: [],
        })).toEqual({
            referenceType: 'capability-artifact',
            assetId: 'artifact-1',
            nodeId: 'node-1',
            artifactTypeId: 'action-timeline',
            displayName: 'Action Timeline',
        })
    })

    it('renders Artifact rows in the standard icon, copy, and badge columns', async () => {
        vi.useFakeTimers()
        const artifact: Extract<PromptReferenceCatalogItem, { referenceType: 'capability-artifact' }> = {
            referenceType: 'capability-artifact',
            referenceId: 'artifact-1',
            assetId: 'artifact-1',
            nodeId: 'node-1',
            artifactTypeId: 'action-timeline',
            source: 'canvas',
            title: 'Action Timeline',
            scope: 'workspace',
            updatedAt: 1,
            displayMetadata: { segmentCount: 8 },
            referenceThumbnailAssetIds: [],
        }
        const artifactCatalog = {
            ...catalog,
            list: vi.fn(async ({ category }: { category: string }) => ({
                items: category === 'artifacts' ? [artifact] : [],
            })),
        }
        const plugin = createAtPromptReferencePickerPlugin(auth, artifactCatalog)
        const mount = document.createElement('div')
        document.body.appendChild(mount)
        const view = new EditorView(mount, { state: createPromptState(plugin) })
        const triggerPos = view.state.selection.from
        view.dispatch(
            view.state.tr
                .insertText('@')
                .setMeta(promptReferencePickerPluginKey, {
                    type: 'open',
                    triggerPos,
                }),
        )
        view.dispatch(view.state.tr.setMeta(promptReferencePickerPluginKey, {
            type: 'category',
            category: 'artifacts',
        }))
        await vi.advanceTimersByTimeAsync(150)
        await Promise.resolve()

        const row = mount.querySelector('.prompt-reference-picker-item-capability-artifact')
        expect(row?.children).toHaveLength(3)
        expect(row?.getAttribute('aria-label')).toBe('Action Timeline')
        expect(row?.getAttribute('data-help-tooltip')).toBe('aria-label')
        expect(row?.getAttribute('title')).toBeNull()
        expect(row?.children[0]?.classList.contains('prompt-reference-picker-glyph')).toBe(true)
        expect(row?.children[0]?.querySelector('svg')).not.toBeNull()
        expect(row?.children[1]?.classList.contains('prompt-reference-picker-artifact-host')).toBe(true)
        expect(row?.children[1]?.textContent).toContain('Action Timeline · 8 segments')
        expect(row?.children[2]?.textContent).toBe('Artifact')

        view.destroy()
    })

    it('ignores stale searches, appends cursor pages, inserts by pointer, and removes its DOM on destroy', async () => {
        vi.useFakeTimers()
        const pending: Array<{
            query: Record<string, unknown>
            resolve: (page: any) => void
        }> = []
        const asyncCatalog = {
            ...catalog,
            list: vi.fn((query: any) =>
                new Promise<any>((resolve) => void pending.push({
                    query,
                    resolve,
                }))
            ),
        }
        const plugin = createSlashCapabilityModulePickerPlugin(auth, asyncCatalog)
        const mount = document.createElement('div')
        document.body.appendChild(mount)
        const view = new EditorView(mount, { state: createPromptState(plugin) })
        const triggerPos = view.state.selection.from
        view.dispatch(
            view.state.tr
                .insertText('/')
                .setMeta(capabilityModulePickerPluginKey, {
                    type: 'open',
                    triggerPos,
                }),
        )
        await vi.advanceTimersByTimeAsync(150)

        view.dispatch(view.state.tr.insertText('c'))
        await vi.advanceTimersByTimeAsync(150)
        expect(pending).toHaveLength(2)

        pending[1]!.resolve({
            items: [{
                referenceType: 'capability-module',
                referenceId: 'character-creator',
                moduleId: 'character-creator',
                name: 'Character Creator',
                normalizedName: 'character creator',
                summary: 'Character sheets.',
                tags: [],
                status: 'active',
            }],
            cursor: 'next-page',
        })
        await Promise.resolve()
        pending[0]!.resolve({
            items: [{
                referenceType: 'capability-module',
                referenceId: 'stale-module',
                moduleId: 'stale-module',
                name: 'Stale Module',
                normalizedName: 'stale module',
                summary: 'Stale.',
                tags: [],
                status: 'active',
            }],
        })
        await Promise.resolve()

        const listbox = mount.querySelector('[role="listbox"]')
        expect(listbox?.textContent).toContain('Character Creator')
        expect(listbox?.textContent).not.toContain('Stale Module')
        expect(listbox?.querySelector<HTMLElement>('[role="option"]')?.ariaSelected).toBe('true')

        const arrowDown = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            cancelable: true,
        })
        view.someProp('handleKeyDown', handler => handler(view, arrowDown))
        expect(pending).toHaveLength(3)
        expect(pending[2]!.query).toMatchObject({ cursor: 'next-page' })
        pending[2]!.resolve({
            items: [{
                referenceType: 'capability-module',
                referenceId: 'style-extraction',
                moduleId: 'style-extraction',
                name: 'Style Extraction',
                normalizedName: 'style extraction',
                summary: 'Extract styles.',
                tags: [],
                status: 'active',
            }],
        })
        await Promise.resolve()
        expect(listbox?.textContent).toContain('Style Extraction')

        listbox?.querySelector<HTMLElement>('[role="option"]')
            ?.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
            }))
        const atoms: Array<Record<string, unknown>> = []
        view.state.doc.descendants((node) => {
            if (node.type.name === 'prompt_reference')
                atoms.push(node.attrs)
        })
        expect(atoms).toEqual([expect.objectContaining({
            referenceType: 'capability-module',
            moduleId: 'character-creator',
        })])

        view.destroy()
        expect(mount.querySelector('.prompt-reference-picker')).toBeNull()
    })

    it('keeps settled rows mounted while loading, then shrinks against the same bottom anchor', async () => {
        vi.useFakeTimers()
        const pending: Array<{ resolve: (page: PromptReferenceCatalogPage) => void }> = []
        const asyncCatalog = {
            ...catalog,
            list: vi.fn(() =>
                new Promise<PromptReferenceCatalogPage>((resolve) => void pending.push({ resolve }))
            ),
        }
        const characterCreator: PromptReferenceCatalogItem = {
            referenceType: 'capability-module',
            referenceId: 'character-creator',
            moduleId: 'character-creator',
            name: 'Character Creator',
            normalizedName: 'character creator',
            summary: 'Character sheets.',
            tags: [],
            status: 'active',
        }
        const styleExtraction: PromptReferenceCatalogItem = {
            referenceType: 'capability-module',
            referenceId: 'style-extraction',
            moduleId: 'style-extraction',
            name: 'Style Extraction',
            normalizedName: 'style extraction',
            summary: 'Extract styles.',
            tags: [],
            status: 'active',
        }
        const plugin = createSlashCapabilityModulePickerPlugin(auth, asyncCatalog)
        const mount = document.createElement('div')
        document.body.appendChild(mount)
        const view = new EditorView(mount, { state: createPromptState(plugin) })
        const triggerPos = view.state.selection.from
        view.dispatch(
            view.state.tr
                .insertText('/')
                .setMeta(capabilityModulePickerPluginKey, {
                    type: 'open',
                    triggerPos,
                }),
        )

        const listbox = mount.querySelector<HTMLDivElement>('[role="listbox"]')

        if (!listbox)
            throw new Error('Expected prompt reference listbox')

        let menuHeight = 300
        vi.spyOn(view, 'coordsAtPos').mockReturnValue({
            left: 200,
            right: 210,
            top: 500,
            bottom: 520,
        })
        vi.spyOn(listbox, 'getBoundingClientRect').mockImplementation(() => ({
            x: 0,
            y: 0,
            width: 440,
            height: menuHeight,
            top: 0,
            right: 440,
            bottom: menuHeight,
            left: 0,
            toJSON: () => ({}),
        }))
        expect(listbox.style.display).toBe('none')

        await vi.advanceTimersByTimeAsync(150)
        pending[0]!.resolve({ items: [characterCreator, styleExtraction] })
        await Promise.resolve()

        const initialRows = listbox.querySelectorAll<HTMLElement>('[role="option"]')
        const initialCharacterRow = initialRows[0]
        const initialStyleRow = initialRows[1]
        expect(listbox.style.display).toBe('flex')
        expect(listbox.classList.contains('prompt-reference-picker-visible')).toBe(true)
        expect(listbox.style.height).toBe('')
        expect(listbox.style.top).toBe('194px')
        const initialBottom = Number.parseFloat(listbox.style.top) + menuHeight

        const arrowDown = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            cancelable: true,
        })
        expect(view.someProp('handleKeyDown', handler => handler(view, arrowDown))).toBe(true)
        expect(listbox.querySelectorAll('[role="option"]')[0]).toBe(initialCharacterRow)
        expect(listbox.querySelectorAll('[role="option"]')[1]).toBe(initialStyleRow)
        expect(initialStyleRow?.ariaSelected).toBe('true')

        view.dispatch(view.state.tr.insertText('c'))
        expect(listbox.textContent).not.toContain('Searching…')
        expect(listbox.ariaBusy).toBe('true')
        expect(listbox.querySelectorAll('[role="option"]')[0]).toBe(initialCharacterRow)

        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            cancelable: true,
        })
        expect(view.someProp('handleKeyDown', handler => handler(view, enter))).toBe(true)
        expect(view.state.doc.textContent).toBe('/c')

        await vi.advanceTimersByTimeAsync(150)
        menuHeight = 100
        pending[1]!.resolve({ items: [characterCreator] })
        await Promise.resolve()

        expect(listbox.ariaBusy).toBeNull()
        expect(listbox.style.height).toBe('')
        expect(listbox.style.top).toBe('394px')
        expect(Number.parseFloat(listbox.style.top) + menuHeight).toBe(initialBottom)
        expect(listbox.querySelectorAll('[role="option"]')[0]).toBe(initialCharacterRow)
        expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(1)

        view.dispatch(view.state.tr.setMeta(capabilityModulePickerPluginKey, { type: 'close' }))
        expect(listbox.classList.contains('prompt-reference-picker-visible')).toBe(false)

        view.destroy()
    })

    it.each(
        [
            [
                {
                    referenceType: 'media',
                    referenceId: 'asset-1',
                    assetId: 'asset-1',
                    nodeId: 'node-1',
                    mediaKind: 'image',
                    source: 'canvas',
                    title: 'Portrait',
                    scope: 'organization',
                    updatedAt: 1,
                },
                {
                    referenceType: 'media',
                    assetId: 'asset-1',
                    nodeId: 'node-1',
                    mediaKind: 'image',
                    displayName: 'Portrait',
                },
            ],
            [
                {
                    referenceType: 'capability-module',
                    referenceId: 'character-creator',
                    moduleId: 'character-creator',
                    name: 'Character Creator',
                    normalizedName: 'character creator',
                    summary: 'Character sheets.',
                    tags: [],
                    status: 'active',
                },
                {
                    referenceType: 'capability-module',
                    moduleId: 'character-creator',
                    displayName: 'Character Creator',
                },
            ],
            [
                {
                    referenceType: 'tool',
                    referenceId: 'tool-1',
                    capabilityId: 'tool-1',
                    kind: 'tool',
                    scopeAndOwner: 'organization#org-1',
                    scope: 'organization',
                    scopeOwnerId: 'org-1',
                    searchKey: 'tool#style#tool-1',
                    name: 'Style',
                    normalizedName: 'style',
                    summary: 'Style.',
                    tags: [],
                    manifestBlobHash: 'hash',
                    catalogExposure: 'standalone',
                    status: 'active',
                    updatedAt: 1,
                },
                {
                    referenceType: 'tool',
                    capabilityId: 'tool-1',
                    displayName: 'Style',
                },
            ],
        ] as const,
    )('maps catalog rows to typed stable atom attributes', (item, expected) => void expect(promptReferenceCatalogItemToAtomAttrs(item as any)).toEqual(expected))
})
