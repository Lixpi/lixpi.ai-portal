import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

const STORAGE_KEY = 'navigationSidePanel:state'

const importFreshStore = async () => {
    // `persistentJSON` reads localStorage once at module init time, and the
    // module itself is a singleton, so each test needs a fresh module graph
    // to observe a different starting localStorage value.
    const module = await import('$src/stores/navigationSidePanelStore.ts')

    return module
}

describe('navigationSidePanelStore', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.resetModules()
    })

    afterEach(() => void localStorage.clear())

    // =============================================================================
    // DEFAULTS AND PERSISTENCE
    // =============================================================================

    describe('defaults and persistence', () => {
        it('defaults to open with no persisted width', async () => {
            const { navigationSidePanelStore } = await importFreshStore()

            expect(navigationSidePanelStore.getData()).toEqual({
                isOpen: true,
                width: null,
            })
            expect(navigationSidePanelStore.getData('isOpen')).toBe(true)
            expect(navigationSidePanelStore.getData('width')).toBeNull()
        })

        it('persists state changes to localStorage under the expected key', async () => {
            const { navigationSidePanelStore } = await importFreshStore()

            navigationSidePanelStore.setValues({
                isOpen: false,
                width: 300,
            })

            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string)
            expect(stored).toEqual({
                isOpen: false,
                width: 300,
            })
        })

        it('rehydrates from a previously persisted value on next import', async () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                isOpen: false,
                width: 456,
            }))

            const { navigationSidePanelStore } = await importFreshStore()

            expect(navigationSidePanelStore.getData()).toEqual({
                isOpen: false,
                width: 456,
            })
        })
    })

    // =============================================================================
    // setValues — PARTIAL MERGE SEMANTICS
    // =============================================================================

    describe('setValues', () => {
        it('merges a partial isOpen update without touching width', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            navigationSidePanelStore.setValues({ width: 320 })

            navigationSidePanelStore.setValues({ isOpen: false })

            expect(navigationSidePanelStore.getData()).toEqual({
                isOpen: false,
                width: 320,
            })
        })

        it('merges a partial width update without touching isOpen', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            navigationSidePanelStore.setValues({ isOpen: false })

            navigationSidePanelStore.setValues({ width: 500 })

            expect(navigationSidePanelStore.getData()).toEqual({
                isOpen: false,
                width: 500,
            })
        })

        it('explicitly clears a persisted width back to null when width is passed as null', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            navigationSidePanelStore.setValues({ width: 500 })

            navigationSidePanelStore.setValues({ width: null })

            expect(navigationSidePanelStore.getData('width')).toBeNull()
        })

        it('leaves width untouched when width is omitted from the call entirely', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            navigationSidePanelStore.setValues({ width: 400 })

            // Only isOpen is present — no `width` key at all, distinct from `{ width: null }`.
            navigationSidePanelStore.setValues({ isOpen: true })

            expect(navigationSidePanelStore.getData('width')).toBe(400)
        })

        it('ignores a non-boolean isOpen value instead of writing it through', async () => {
            const { navigationSidePanelStore } = await importFreshStore()

            // @ts-expect-error deliberately passing a bad runtime value
            navigationSidePanelStore.setValues({ isOpen: undefined })

            expect(navigationSidePanelStore.getData('isOpen')).toBe(true)
        })

        it('supports calling setValues with no arguments as a no-op', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            navigationSidePanelStore.setValues({
                isOpen: false,
                width: 250,
            })

            navigationSidePanelStore.setValues()

            expect(navigationSidePanelStore.getData()).toEqual({
                isOpen: false,
                width: 250,
            })
        })
    })

    // =============================================================================
    // resetStore
    // =============================================================================

    describe('resetStore', () => {
        it('restores the default state and persists it', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            navigationSidePanelStore.setValues({
                isOpen: false,
                width: 700,
            })

            navigationSidePanelStore.resetStore()

            expect(navigationSidePanelStore.getData()).toEqual({
                isOpen: true,
                width: null,
            })
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string)
            expect(stored).toEqual({
                isOpen: true,
                width: null,
            })
        })
    })

    // =============================================================================
    // subscribe/listen — NOTIFICATION SEMANTICS
    // =============================================================================

    describe('subscribe', () => {
        it('notifies subscribers with the merged state after setValues', async () => {
            const { navigationSidePanelStore } = await importFreshStore()
            const seen: Array<{
                isOpen: boolean
                width: number | null
            }> = []
            const unsubscribe = navigationSidePanelStore.subscribe((state) => void seen.push(state))

            navigationSidePanelStore.setValues({ width: 333 })

            expect(seen.at(-1)).toEqual({
                isOpen: true,
                width: 333,
            })

            unsubscribe()
            navigationSidePanelStore.setValues({ width: 999 })
            expect(seen.at(-1)).toEqual({
                isOpen: true,
                width: 333,
            })
        })
    })

})
