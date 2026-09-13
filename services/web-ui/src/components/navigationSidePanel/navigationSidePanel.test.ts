import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    LoadingStatus,
    type WorkspaceMeta,
} from '@lixpi/constants'
import {
    createRouterService,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'

// =============================================================================
// MOCKED COLLABORATORS
// =============================================================================
//
// NavigationSidePanel drives real navigation, workspace CRUD, auth, and file
// import/export side effects. Those collaborators are mocked so tests assert
// on *what NavigationSidePanel asked them to do*, not on their own internals
// (which have their own test suites). The nanostores-backed panel/workspace
// stores below are exercised for real — they are cheap, synchronous, and
// resettable, so mocking them would just hide real integration bugs.

const mocks = vi.hoisted(() => ({
    navigateTo: vi.fn(),
    createWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    getWorkspace: vi.fn().mockResolvedValue(undefined),
    getTokenSilently: vi.fn(),
    loadWorkspaceAssets: vi.fn().mockResolvedValue(undefined),
    dropdownInstances: [] as Array<{
        dom: HTMLDivElement
        destroy: () => void
        config: any
    }>,
}))

// The dropdown is a fully separate, already-tested component. NavigationSidePanel's
// own responsibility is *what it configures the dropdown with* (options, onSelect
// routing) — that's what these tests exercise, via the captured config.
vi.mock('@lixpi/ui-kit/components/dropdown', () => ({
    createPureDropdown: vi.fn((config: any) => {
        const dom = document.createElement('div')
        dom.className = 'mock-dropdown'
        const instance = {
            dom,
            destroy: vi.fn(),
            config,
        }
        mocks.dropdownInstances.push(instance)

        return instance
    }),
}))

import {
    createNavigationSidePanel,
    type NavigationSidePanelInstance,
} from '$src/components/navigationSidePanel/navigationSidePanel.ts'
import { workspacesStore } from '$src/stores/workspacesStore.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'
import { createAuthStore } from '@lixpi/auth-client'
import { servicesStore } from '$src/stores/servicesStore.ts'
import {
    navigationSidePanelStore,
    userInfoPanelStore,
} from '$src/stores/navigationSidePanelStore.ts'
import { settings } from '$src/settings.ts'

const makeWorkspace = (overrides: Partial<WorkspaceMeta> & { tags?: string[] } = {}): WorkspaceMeta => {
    return {
        workspaceId: 'workspace-1',
        name: 'Workspace One',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    } as WorkspaceMeta
}

const setCurrentWorkspaceId = (workspaceId: string | undefined): void => {
    router.navigateTo('/workspace/:workspaceId', {
        params: workspaceId ? { workspaceId } : {},
        shouldFetchData: false,
    })
}

const authStore = createAuthStore()
const auth = {
    authStore,
    getTokenSilently: mocks.getTokenSilently,
}

const mount = (): {
    paneEl: HTMLDivElement
    instance: NavigationSidePanelInstance
} => {
    const paneEl = document.createElement('div')
    document.body.appendChild(paneEl)
    const instance = createNavigationSidePanel({
        auth,
        paneEl,
        router,
        workspaceService,
    })

    return {
        paneEl,
        instance,
    }
}

// Nano Stores replay their current value to a listener the moment it
// subscribes, so the constructor's `renderWorkspaceList()` call is immediately
// followed by one more synchronous re-render from `workspacesStore.subscribe`.
// The live dropdown for a workspace is therefore the *last* one captured, not
// the first — the first is already torn down by the time mount() returns.
const liveDropdownFor = (workspaceId: string) => {
    const matches = mocks.dropdownInstances.filter((entry) => entry.config.id === `navigation-side-panel-workspace-menu-${workspaceId}`)
    const instance = matches.at(-1)

    if (!instance)
        throw new Error(`no dropdown captured for ${workspaceId}`)

    return instance
}

const dropdownConfigFor = (workspaceId: string) => liveDropdownFor(workspaceId).config

let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null
let router: WebClientRouterService

const workspaceService = {
    createWorkspace: mocks.createWorkspace,
    deleteWorkspace: mocks.deleteWorkspace,
    getWorkspace: mocks.getWorkspace,
}

beforeEach(() => {
    mocks.dropdownInstances.length = 0
    mocks.navigateTo.mockClear()
    mocks.createWorkspace.mockClear()
    mocks.deleteWorkspace.mockClear()
    mocks.getWorkspace.mockClear()
    mocks.getTokenSilently.mockReset()
    mocks.loadWorkspaceAssets.mockClear()

    workspacesStore.resetStore()
    workspaceStore.resetStore()
    servicesStore.resetStore()
    authStore.resetStore()
    navigationSidePanelStore.resetStore()
    userInfoPanelStore.set(false)

    servicesStore.setDataValues({
        assetService: { loadWorkspaceAssets: mocks.loadWorkspaceAssets },
    })

    router = createRouterService({
        routes: [
            { path: '/' },
            { path: '/workspace/:workspaceId' },
        ],
    })
    const navigateTo = router.navigateTo.bind(router)
    vi.spyOn(router, 'navigateTo').mockImplementation((path, options) => {
        mocks.navigateTo(path, options)
        navigateTo(path, options)
    })

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
    document.body.innerHTML = ''
    router.destroy()
    consoleErrorSpy?.mockRestore()
    consoleErrorSpy = null
})

// =============================================================================
// MOUNTING AND STRUCTURE
// =============================================================================

describe('NavigationSidePanel — mounting', () => {
    it('mounts the panel, enabled side-panel surfaces, and the new-workspace button into the host pane', () => {
        const {
            paneEl,
            instance,
        } = mount()

        expect(paneEl.querySelector('.navigation-side-panel')).not.toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-header')).not.toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-list')).not.toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-footer')).not.toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-new-workspace-button')).not.toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-resize-handle')).not.toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-toggle')).not.toBeNull()
        expect(paneEl.querySelector('.side-panel-overlay')).toBeNull()
        expect(paneEl.querySelector('.side-panel-backdrop')).not.toBeNull()

        instance.destroy()
    })

    it('reflects the resolved panel width onto both the pane and panel elements as CSS custom properties', () => {
        const {
            paneEl,
            instance,
        } = mount()

        // Never resized -> falls back to settings.navigationSidePanel.defaultDimensions.width (280).
        expect(paneEl.style.getPropertyValue('--workspace-navigation-side-panel-width')).toBe('280px')
        expect(paneEl.style.getPropertyValue('--side-panel-backdrop-width')).toBe('280px')
        const panelEl = paneEl.querySelector<HTMLDivElement>('.navigation-side-panel')
        expect(panelEl?.style.getPropertyValue('--side-panel-backdrop-width')).toBe('280px')

        instance.destroy()
    })

    it('applies visual style tokens from app settings to the host pane', () => {
        const {
            paneEl,
            instance,
        } = mount()

        expect(paneEl.style.getPropertyValue('--side-panel-backdrop-fill')).toBe(settings.navigationSidePanel.styles.backdropFill)
        expect(paneEl.style.getPropertyValue('--side-panel-backdrop-fill-opaque')).toBe(settings.navigationSidePanel.styles.backdropFillOpaque)
        expect(paneEl.style.getPropertyValue('--side-panel-toggle-color')).toBe(settings.navigationSidePanel.styles.toggleColor)
        expect(paneEl.style.getPropertyValue('--side-panel-toggle-hover-color')).toBe(settings.navigationSidePanel.styles.toggleHoverColor)

        instance.destroy()
    })

    it('starts open by default and renders the panel at rest, matching the store default', () => {
        const {
            paneEl,
            instance,
        } = mount()

        expect(navigationSidePanelStore.getData('isOpen')).toBe(true)
        const panelEl = paneEl.querySelector<HTMLDivElement>('.navigation-side-panel')
        expect(panelEl?.style.transform).not.toBe('translate3d(-100%, 0, 0)')

        instance.destroy()
    })

    it('mounts closed at rest when the persisted store state says closed', () => {
        navigationSidePanelStore.setValues({ isOpen: false })
        const {
            paneEl,
            instance,
        } = mount()

        const panelEl = paneEl.querySelector<HTMLDivElement>('.navigation-side-panel')
        expect(panelEl?.style.transform).toBe('translate3d(-100%, 0, 0)')
        const backdropEl = paneEl.querySelector<HTMLDivElement>('.side-panel-backdrop')
        expect(backdropEl?.style.transform).toBe('translate3d(-100%, 0, 0)')

        instance.destroy()
    })
})

// =============================================================================
// AVATAR RENDERING
// =============================================================================

describe('NavigationSidePanel — avatar', () => {
    it('renders an initial letter fallback when there is no signed-in user', () => {
        const {
            paneEl,
            instance,
        } = mount()

        const avatar = paneEl.querySelector('.navigation-side-panel-avatar')
        expect(avatar?.querySelector('img')).toBeNull()
        expect(avatar?.querySelector('.navigation-side-panel-avatar-initial')?.textContent).toBe('U')

        instance.destroy()
    })

    it('renders an <img> from the user picture when available', () => {
        const {
            paneEl,
            instance,
        } = mount()
        authStore.setDataValues({ user: {
            userId: 'u1',
            name: 'Ada Lovelace',
            email: 'a@example.com',
            picture: 'https://example.com/a.png',
            given_name: 'Ada',
        } as any })

        const avatar = paneEl.querySelector('.navigation-side-panel-avatar')
        const img = avatar?.querySelector('img')
        expect(img?.getAttribute('src')).toBe('https://example.com/a.png')
        expect(img?.getAttribute('alt')).toBe('Ada')

        instance.destroy()
    })

    it('falls back to the given_name initial when there is no picture', () => {
        const {
            paneEl,
            instance,
        } = mount()
        authStore.setDataValues({ user: {
            userId: 'u1',
            name: 'Grace Hopper',
            email: 'g@example.com',
            given_name: 'Grace',
        } as any })

        const avatar = paneEl.querySelector('.navigation-side-panel-avatar')
        expect(avatar?.querySelector('.navigation-side-panel-avatar-initial')?.textContent).toBe('G')

        instance.destroy()
    })

    it('re-renders the avatar reactively when the auth store changes after mount', () => {
        const {
            paneEl,
            instance,
        } = mount()
        expect(paneEl.querySelector('.navigation-side-panel-avatar-initial')?.textContent).toBe('U')

        authStore.setDataValues({ user: {
            userId: 'u1',
            name: 'Zoe',
            email: 'z@example.com',
            given_name: 'Zoe',
        } as any })
        expect(paneEl.querySelector('.navigation-side-panel-avatar-initial')?.textContent).toBe('Z')

        instance.destroy()
    })

    it('opens the account/user-info panel when the avatar is clicked', () => {
        const {
            paneEl,
            instance,
        } = mount()
        expect(userInfoPanelStore.get()).toBe(false)

        paneEl.querySelector<HTMLElement>('.navigation-side-panel-avatar')?.click()

        expect(userInfoPanelStore.get()).toBe(true)

        instance.destroy()
    })
})

// =============================================================================
// WORKSPACE LIST RENDERING
// =============================================================================

describe('NavigationSidePanel — workspace list', () => {
    it('renders one row per workspace with its name and tags', () => {
        workspacesStore.setWorkspaces([
            makeWorkspace({
                workspaceId: 'ws-1',
                name: 'Alpha',
                tags: ['a', 'b'],
            }),
            makeWorkspace({
                workspaceId: 'ws-2',
                name: 'Beta',
            }),
        ])
        const {
            paneEl,
            instance,
        } = mount()

        const rows = paneEl.querySelectorAll('.navigation-side-panel-row')
        expect(rows.length).toBe(2)
        expect(rows[0].querySelector('.navigation-side-panel-row-title')?.textContent).toBe('Alpha')
        expect(Array.from(rows[0].querySelectorAll('.navigation-side-panel-row-tag')).map((el) => el.textContent)).toEqual(['a', 'b'])
        expect(rows[1].querySelector('.navigation-side-panel-row-tags')).toBeNull()

        instance.destroy()
    })

    it('marks the row for the workspace that matches the current route as active', () => {
        workspacesStore.setWorkspaces([
            makeWorkspace({
                workspaceId: 'ws-1',
                name: 'Alpha',
            }),
            makeWorkspace({
                workspaceId: 'ws-2',
                name: 'Beta',
            }),
        ])
        setCurrentWorkspaceId('ws-2')
        const {
            paneEl,
            instance,
        } = mount()

        const rows = paneEl.querySelectorAll('.navigation-side-panel-row')
        expect(rows[0].classList.contains('navigation-side-panel-row-active')).toBe(false)
        expect(rows[1].classList.contains('navigation-side-panel-row-active')).toBe(true)

        instance.destroy()
    })

    it('re-renders the list when the workspaces store changes after mount', () => {
        const {
            paneEl,
            instance,
        } = mount()
        expect(paneEl.querySelectorAll('.navigation-side-panel-row').length).toBe(0)

        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])

        expect(paneEl.querySelectorAll('.navigation-side-panel-row').length).toBe(1)

        instance.destroy()
    })

    it('re-renders the list when the active router workspace changes after mount', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        expect(paneEl.querySelector('.navigation-side-panel-row')?.classList.contains('navigation-side-panel-row-active')).toBe(false)

        setCurrentWorkspaceId('ws-1')

        expect(paneEl.querySelector('.navigation-side-panel-row')?.classList.contains('navigation-side-panel-row-active')).toBe(true)

        instance.destroy()
    })

    it('destroys every previous row dropdown before rendering the next list snapshot', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const { instance } = mount()
        const liveDropdown = liveDropdownFor('ws-1')
        expect(liveDropdown.destroy).not.toHaveBeenCalled()

        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha (renamed)',
        })])

        expect(liveDropdown.destroy).toHaveBeenCalledTimes(1)
        expect(liveDropdownFor('ws-1')).not.toBe(liveDropdown)

        instance.destroy()
    })

    it('stops row-menu clicks from bubbling into the row navigation handler', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()

        const menuAnchor = paneEl.querySelector<HTMLElement>('.navigation-side-panel-row-menu')
        menuAnchor?.click()

        expect(mocks.navigateTo).not.toHaveBeenCalled()

        instance.destroy()
    })
})

// =============================================================================
// NAVIGATION AND WORKSPACE CREATION
// =============================================================================

describe('NavigationSidePanel — navigation and creation', () => {
    it('begins loading the clicked workspace in the click handler so stale canvas content clears immediately', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        workspaceStore.setDataValues({
            workspaceId: 'old-workspace',
            canvasState: {
                viewport: {
                    x: 1,
                    y: 2,
                    zoom: 1,
                },
                nodes: [{
                    nodeId: 'old-node',
                    type: 'image',
                } as any],
                edges: [],
            },
        })
        workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        const {
            paneEl,
            instance,
        } = mount()

        paneEl.querySelector<HTMLButtonElement>('.navigation-side-panel-row')?.click()

        expect(workspaceStore.getData('workspaceId')).toBe('ws-1')
        expect(workspaceStore.getData('canvasState')).toEqual({
            viewport: {
                x: 0,
                y: 0,
                zoom: 1,
            },
            nodes: [],
            edges: [],
        })
        expect(workspaceStore.getMeta('loadingStatus')).toBe(LoadingStatus.loading)
        expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith('/workspace/:workspaceId', {
            params: { workspaceId: 'ws-1' },
            shouldFetchData: true,
        })

        instance.destroy()
    })

    it('creates a new workspace when the header button is clicked', async () => {
        const {
            paneEl,
            instance,
        } = mount()

        paneEl.querySelector<HTMLButtonElement>('.navigation-side-panel-new-workspace-button')?.click()
        await Promise.resolve()

        expect(mocks.createWorkspace).toHaveBeenCalledExactlyOnceWith({ name: 'New Workspace' })

        instance.destroy()
    })
})

// =============================================================================
// ROW MENU ACTIONS — import / export / delete
// =============================================================================

describe('NavigationSidePanel — row menu actions', () => {
    it('routes the Delete option to WorkspaceService.deleteWorkspace for that row', async () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const { instance } = mount()

        dropdownConfigFor('ws-1').onSelect({ title: 'Delete' })
        await Promise.resolve()

        expect(mocks.deleteWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws-1' })

        instance.destroy()
    })

    it('routes the Import option to arming the hidden file input for that row, not to a service call', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement
        const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => undefined)

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })

        expect(clickSpy).toHaveBeenCalledTimes(1)
        expect(mocks.deleteWorkspace).not.toHaveBeenCalled()
        expect(mocks.getWorkspace).not.toHaveBeenCalled()

        instance.destroy()
    })

    it('opens the export URL with a fresh auth token when Export is selected', async () => {
        mocks.getTokenSilently.mockResolvedValue('token-123')
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const { instance } = mount()

        dropdownConfigFor('ws-1').onSelect({ title: 'Export' })
        await Promise.resolve()
        await Promise.resolve()

        expect(openSpy).toHaveBeenCalledExactlyOnceWith(
            expect.stringMatching(/\/api\/workspaces\/ws-1\/export\?token=token-123$/),
            '_blank',
        )

        openSpy.mockRestore()
        instance.destroy()
    })

    it('does not open the export URL when no auth token is available', async () => {
        mocks.getTokenSilently.mockResolvedValue(null)
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const { instance } = mount()

        dropdownConfigFor('ws-1').onSelect({ title: 'Export' })
        await Promise.resolve()
        await Promise.resolve()

        expect(openSpy).not.toHaveBeenCalled()

        openSpy.mockRestore()
        instance.destroy()
    })
})

// =============================================================================
// WORKSPACE IMPORT FLOW (hidden file input)
// =============================================================================

describe('NavigationSidePanel — workspace import flow', () => {
    const selectFile = (input: HTMLInputElement, file: File): void => {
        Object.defineProperty(input, 'files', {
            value: [file],
            configurable: true,
        })
        input.dispatchEvent(new Event('change'))
    }

    let fetchSpy: ReturnType<typeof vi.spyOn> | null = null

    beforeEach(() => void (fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>))

    afterEach(() => {
        fetchSpy?.mockRestore()
        fetchSpy = null
    })

    it('does nothing when a file is chosen without first arming an import target', async () => {
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()

        expect(fetchSpy).not.toHaveBeenCalled()

        instance.destroy()
    })

    it('uploads the selected file with an auth bearer token to the target workspace', async () => {
        mocks.getTokenSilently.mockResolvedValue('token-abc')
        fetchSpy?.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        } as Response)
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })
        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
            expect.stringMatching(/\/api\/workspaces\/ws-1\/import$/),
            expect.objectContaining({
                method: 'POST',
                headers: { Authorization: 'Bearer token-abc' },
            }),
        )
        const requestInit = fetchSpy?.mock.calls[0]?.[1] as RequestInit
        const body = requestInit?.body
        expect(body).toBeInstanceOf(FormData)
        expect(body?.get('file')).toBeInstanceOf(File)
        expect(body?.get('file')?.name).toBe('workspace.zip')

        instance.destroy()
    })

    it('does not upload when no auth token is available', async () => {
        mocks.getTokenSilently.mockResolvedValue(null)
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })
        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()
        await Promise.resolve()

        expect(fetchSpy).not.toHaveBeenCalled()

        instance.destroy()
    })

    it('refreshes workspace metadata and assets only when the import target is the currently open workspace', async () => {
        mocks.getTokenSilently.mockResolvedValue('token-abc')
        fetchSpy?.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        } as Response)
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        setCurrentWorkspaceId('ws-1')
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })
        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        expect(mocks.getWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws-1' })
        expect(mocks.loadWorkspaceAssets).toHaveBeenCalledExactlyOnceWith('ws-1')

        instance.destroy()
    })

    it('does not refresh the open workspace when the import target is a different workspace', async () => {
        mocks.getTokenSilently.mockResolvedValue('token-abc')
        fetchSpy?.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        } as Response)
        workspacesStore.setWorkspaces([
            makeWorkspace({
                workspaceId: 'ws-1',
                name: 'Alpha',
            }),
            makeWorkspace({
                workspaceId: 'ws-2',
                name: 'Beta',
            }),
        ])
        setCurrentWorkspaceId('ws-2')
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })
        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        expect(mocks.getWorkspace).not.toHaveBeenCalled()
        expect(mocks.loadWorkspaceAssets).not.toHaveBeenCalled()

        instance.destroy()
    })

    it('logs and does not attempt a refresh when the backend reports an import failure', async () => {
        mocks.getTokenSilently.mockResolvedValue('token-abc')
        fetchSpy?.mockResolvedValue({
            ok: false,
            json: async () => ({ error: 'bad zip' }),
        } as Response)
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        setCurrentWorkspaceId('ws-1')
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })
        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        expect(consoleErrorSpy).toHaveBeenCalledWith('Workspace import failed:', { error: 'bad zip' })
        expect(mocks.getWorkspace).not.toHaveBeenCalled()

        instance.destroy()
    })

    it('logs and swallows a network failure during upload instead of throwing', async () => {
        mocks.getTokenSilently.mockResolvedValue('token-abc')
        fetchSpy?.mockRejectedValue(new Error('network down'))
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })
        selectFile(input, new File(['zip'], 'workspace.zip'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        expect(consoleErrorSpy).toHaveBeenCalledWith('Workspace import failed:', expect.any(Error))

        instance.destroy()
    })

    it('clears the file input value and the import target before reading the next selection', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement

        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })

        expect(input.value).toBe('')

        instance.destroy()
    })
})

// =============================================================================
// TOGGLE OPEN/CLOSE
// =============================================================================

describe('NavigationSidePanel — open/close toggle', () => {
    it('flips the persisted isOpen state when the toggle button is clicked', () => {
        const {
            paneEl,
            instance,
        } = mount()
        expect(navigationSidePanelStore.getData('isOpen')).toBe(true)

        paneEl.querySelector<HTMLButtonElement>('.navigation-side-panel-toggle')?.click()

        expect(navigationSidePanelStore.getData('isOpen')).toBe(false)

        paneEl.querySelector<HTMLButtonElement>('.navigation-side-panel-toggle')?.click()

        expect(navigationSidePanelStore.getData('isOpen')).toBe(true)

        instance.destroy()
    })
})

// =============================================================================
// DESTROY / CLEANUP
// =============================================================================

describe('NavigationSidePanel — destroy', () => {
    it('removes the panel and its side-panel surfaces from the host pane', () => {
        const {
            paneEl,
            instance,
        } = mount()

        instance.destroy()

        expect(paneEl.querySelector('.navigation-side-panel')).toBeNull()
        expect(paneEl.querySelector('.navigation-side-panel-toggle')).toBeNull()
        expect(paneEl.querySelector('.side-panel-overlay')).toBeNull()
        expect(paneEl.querySelector('.side-panel-backdrop')).toBeNull()
    })

    it('destroys every live row dropdown and stops reacting to store changes', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const dropdown = liveDropdownFor('ws-1')

        instance.destroy()

        expect(dropdown.destroy).toHaveBeenCalledTimes(1)

        // Store churn after destroy must not touch a torn-down DOM tree.
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-2',
            name: 'Beta',
        })])
        expect(paneEl.querySelector('.navigation-side-panel-row')).toBeNull()
    })

    it('stops listening for the import input change event after destroy', () => {
        workspacesStore.setWorkspaces([makeWorkspace({
            workspaceId: 'ws-1',
            name: 'Alpha',
        })])
        const {
            paneEl,
            instance,
        } = mount()
        const input = paneEl.querySelector<HTMLInputElement>('.navigation-side-panel-import-input') as HTMLInputElement
        dropdownConfigFor('ws-1').onSelect({ title: 'Import' })

        instance.destroy()
        Object.defineProperty(input, 'files', {
            value: [new File(['zip'], 'w.zip')],
            configurable: true,
        })
        input.dispatchEvent(new Event('change'))

        expect(mocks.getTokenSilently).not.toHaveBeenCalled()
    })
})
