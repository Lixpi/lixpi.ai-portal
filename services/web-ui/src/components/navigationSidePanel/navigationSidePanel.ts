// NavigationSidePanel - workspace-list side panel built on the shared SidePanel component.
//
// Renderer: TypeScript `html` DOM. Store access stays behind small store APIs
// so the panel remains a framework-agnostic DOM component.

import {
    type WorkspaceMeta,
} from '@lixpi/constants'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import {
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'

import {
    html,
    applyStyle,
} from '@lixpi/ui-primitives/dom'
import {
    createSidePanel,
    type SidePanelInstance,
} from '@lixpi/ui-kit/components/side-panel'
import { createPureDropdown } from '@lixpi/ui-kit/components/dropdown'
import { settings } from '$src/settings.ts'
import {
    createNewFileIcon,
    navigationSidePanelToggleIcon,
    verticalTrippleDots,
} from '@lixpi/ui-kit/svg'

import { workspacesStore } from '$src/stores/workspacesStore.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'
import { servicesStore } from '$src/stores/servicesStore.ts'
import {
    navigationSidePanelStore,
    userInfoPanelStore,
} from '$src/stores/navigationSidePanelStore.ts'

const NAVIGATION_SIDE_PANEL_SETTINGS = settings.navigationSidePanel

export type NavigationSidePanelConfig = {
    // Host element the panel/backdrop/overlay/toggle/resize-handle mount into.
    auth: Pick<AuthClientInstance, 'authStore' | 'getTokenSilently'>
    paneEl: HTMLElement
    router: Pick<WebClientRouterService, 'getCurrentRoute' | 'navigateTo' | 'subscribe'>
    workspaceService: {
        createWorkspace: (input: { name: string }) => Promise<void>
        deleteWorkspace: (input: { workspaceId: string }) => Promise<void>
        getWorkspace: (input: { workspaceId: string }) => Promise<void>
    }
}

export type NavigationSidePanelInstance = {
    destroy: () => void
}

class NavigationSidePanel implements NavigationSidePanelInstance {
    private readonly paneEl: HTMLElement
    private readonly unsubscribers: Array<() => void> = []
    private readonly workspaceDropdowns = new Map<string, ReturnType<typeof createPureDropdown>>()
    private readonly panelEl: HTMLDivElement
    private readonly headerEl: HTMLDivElement
    private readonly listEl: HTMLDivElement
    private readonly footerEl: HTMLDivElement
    private readonly avatarEl: HTMLSpanElement
    private readonly importFileInput: HTMLInputElement
    private readonly sidePanel: SidePanelInstance
    private readonly auth: NavigationSidePanelConfig['auth']
    private readonly router: NavigationSidePanelConfig['router']
    private readonly workspaceService: NavigationSidePanelConfig['workspaceService']
    private importTargetWorkspaceId: string | null = null

    constructor(config: NavigationSidePanelConfig) {
        this.auth = config.auth
        this.paneEl = config.paneEl
        this.router = config.router
        this.workspaceService = config.workspaceService
        this.panelEl = html`<div className="navigation-side-panel"></div>` as HTMLDivElement
        this.headerEl = html`<div className="navigation-side-panel-header"></div>` as HTMLDivElement
        this.listEl = html`<div className="navigation-side-panel-list"></div>` as HTMLDivElement
        this.footerEl = html`<div className="navigation-side-panel-footer"></div>` as HTMLDivElement
        this.avatarEl = html`
            <span
                className="navigation-side-panel-avatar"
                role="button"
                aria-label="Account"
                onclick=${this.openUserInfoPanel}
            ></span>
        ` as HTMLSpanElement
        this.importFileInput = html`
            <input
                type="file"
                accept=".zip"
                className="navigation-side-panel-import-input"
            />
        ` as HTMLInputElement
        this.importFileInput.addEventListener('change', this.handleImportFileSelected)

        this.headerEl.appendChild(
            this.createNewWorkspaceButton(),
        )
        this.footerEl.append(html`<div className="navigation-side-panel-footer-separator"></div>` as HTMLDivElement, this.avatarEl)
        this.panelEl.append(
            this.headerEl,
            this.listEl,
            this.footerEl,
            this.importFileInput,
        )
        this.paneEl.appendChild(this.panelEl)

        this.sidePanel = createSidePanel({
            root: this.paneEl,
            side: 'left',
            offset: NAVIGATION_SIDE_PANEL_SETTINGS.resizeHandle.offset,
            grabWidth: NAVIGATION_SIDE_PANEL_SETTINGS.resizeHandle.grabWidth,
            className: 'navigation-side-panel-resize-handle',
            styles: NAVIGATION_SIDE_PANEL_SETTINGS.resizeHandle.styles,
            overlay: NAVIGATION_SIDE_PANEL_SETTINGS.overlay,
            drag: NAVIGATION_SIDE_PANEL_SETTINGS.drag,
            toggle: {
                iconSvg: navigationSidePanelToggleIcon,
                className: 'navigation-side-panel-toggle',
                motion: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.motion,
                openAriaLabel: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.openAriaLabel,
                closedAriaLabel: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.closedAriaLabel,
                openOffset: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.openOffset,
                closedTravel: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.closedTravel,
                top: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.top,
                size: NAVIGATION_SIDE_PANEL_SETTINGS.toggle.size,
                onToggle: this.toggleVisibility,
            },
            animation: NAVIGATION_SIDE_PANEL_SETTINGS.animation,
            minWidth: NAVIGATION_SIDE_PANEL_SETTINGS.dimensions.minWidth,
            defaultWidth: NAVIGATION_SIDE_PANEL_SETTINGS.defaultDimensions.width,
            getMaxWidth: this.getMaxWidth,
            measureWidth: () => this.panelEl.getBoundingClientRect().width || NAVIGATION_SIDE_PANEL_SETTINGS.defaultDimensions.width,
            loadState: () => ({ width: navigationSidePanelStore.getData().width }),
            persistState: state => navigationSidePanelStore.setValues({ width: state.width ?? null }),
            onResize: this.reflectWidth,
            onResizeEnd: this.reflectWidth,
            onOpenChange: this.handleOpenChange,
        })

        this.reflectStyleSettings()

        if (this.sidePanel.toggleElement)
            this.paneEl.appendChild(this.sidePanel.toggleElement)

        if (this.sidePanel.overlayElement)
            this.paneEl.appendChild(this.sidePanel.overlayElement)

        this.paneEl.appendChild(this.sidePanel.backdropElement)
        this.panelEl.appendChild(this.sidePanel.element)

        this.reflectWidth(
            this.sidePanel.getWidth(),
        )
        this.reflectInitialOpenState()

        this.renderWorkspaceList()
        this.unsubscribers.push(
            workspacesStore.subscribe(this.renderWorkspaceList),
        )
        this.unsubscribers.push(
            this.router.subscribe(this.renderWorkspaceList),
        )

        this.renderAvatar()
        this.unsubscribers.push(
            this.auth.authStore.subscribe(this.renderAvatar),
        )
    }

    private createNewWorkspaceButton(): HTMLButtonElement {
        return html`
            <button
                type="button"
                className="navigation-side-panel-new-workspace-button"
                aria-label="New workspace"
                innerHTML=${createNewFileIcon}
                onclick=${this.handleCreateNewWorkspaceClick}
            ></button>
        ` as HTMLButtonElement
    }

    private openUserInfoPanel = (): void => void userInfoPanelStore.set(true)

    private renderAvatar = (): void => {
        const user = this.auth.authStore.getData('user') as {
            picture?: string
            given_name?: string
            name?: string
        } | null
        this.avatarEl.replaceChildren()

        if (user?.picture) {
            this.avatarEl.appendChild(
                html`
                    <img
                        src=${user.picture}
                        alt=${user.given_name || 'User'}
                        referrerpolicy="no-referrer"
                    />
                ` as HTMLImageElement,
            )
        } else {
            const initial = (user?.given_name || user?.name || 'User').charAt(0).toUpperCase()
            this.avatarEl.appendChild(html`<span className="navigation-side-panel-avatar-initial">${initial}</span>` as HTMLSpanElement)
        }
    }

    private getMaxWidth = (): number => {
        const paneWidth = this.paneEl.getBoundingClientRect().width || window.innerWidth

        return Math.max(NAVIGATION_SIDE_PANEL_SETTINGS.dimensions.minWidth, paneWidth - NAVIGATION_SIDE_PANEL_SETTINGS.dimensions.maxPaneMargin)
    }

    private reflectWidth = (width: number): void => {
        const widthValue = `${width}px`
        this.paneEl.style.setProperty('--workspace-navigation-side-panel-width', widthValue)
        this.paneEl.style.setProperty('--side-panel-backdrop-width', widthValue)
        this.panelEl.style.setProperty('--side-panel-backdrop-width', widthValue)
    }

    private reflectStyleSettings = (): void => {
        this.paneEl.style.setProperty('--side-panel-backdrop-fill', NAVIGATION_SIDE_PANEL_SETTINGS.styles.backdropFill)
        this.paneEl.style.setProperty('--side-panel-backdrop-fill-opaque', NAVIGATION_SIDE_PANEL_SETTINGS.styles.backdropFillOpaque)
        this.paneEl.style.setProperty('--side-panel-toggle-color', NAVIGATION_SIDE_PANEL_SETTINGS.styles.toggleColor)
        this.paneEl.style.setProperty('--side-panel-toggle-hover-color', NAVIGATION_SIDE_PANEL_SETTINGS.styles.toggleHoverColor)
    }

    private reflectInitialOpenState(): void {
        if (navigationSidePanelStore.getData().isOpen) {
            this.sidePanel.mountOpen(this.panelEl)

            return
        }

        applyStyle(this.panelEl, { transform: 'translate3d(-100%, 0, 0)' })
        applyStyle(this.sidePanel.backdropElement, { transform: 'translate3d(-100%, 0, 0)' })
        this.sidePanel.setOpen(false)
    }

    private handleOpenChange = (open: boolean): void => {
        navigationSidePanelStore.setValues({ isOpen: open })
        void this.runSlide(open)
    }

    private runSlide = async (open: boolean): Promise<void> => {
        if (open)
            await this.sidePanel.playOpen(this.panelEl)
        else
            await this.sidePanel.playClose()
    }

    private toggleVisibility = (): void => {
        const isOpen = navigationSidePanelStore.getData().isOpen
        navigationSidePanelStore.setValues({ isOpen: !isOpen })
        void this.runSlide(!isOpen)
    }

    // --- Workspace list rendering -------------------------------------------------

    private renderWorkspaceList = (): void => {
        const workspaces = workspacesStore.getData()
        const currentWorkspaceId = this.router.getCurrentRoute().routeParams.workspaceId

        for (const dropdown of this.workspaceDropdowns.values())
            dropdown.destroy()

        this.workspaceDropdowns.clear()

        this.listEl.replaceChildren()

        for (const workspace of workspaces) {
            this.listEl.appendChild(
                this.renderWorkspaceRow(workspace, currentWorkspaceId),
            )
        }
    }

    private renderWorkspaceRow(
        workspace: WorkspaceMeta,
        currentWorkspaceId: string | undefined,
    ): HTMLElement {
        const isActive = currentWorkspaceId === workspace.workspaceId

        const menuAnchor = html`<div className="navigation-side-panel-row-menu"></div>` as HTMLDivElement
        const dropdown = createPureDropdown({
            id: `navigation-side-panel-workspace-menu-${workspace.workspaceId}`,
            selectedValue: { title: '' },
            options: [
                { title: 'Import' },
                { title: 'Export' },
                { title: 'Delete' },
            ],
            theme: 'dark',
            buttonIcon: verticalTrippleDots,
            disableTriggerHover: true,
            renderTitleForSelectedValue: false,
            renderIconForSelectedValue: false,
            renderIconForOptions: false,
            mountToBody: true,
            onSelect: option => {
                if (option.title === 'Import')
                    this.onWorkspaceImportHandler(workspace.workspaceId)
                else if (option.title === 'Export')
                    void this.onWorkspaceExportHandler(workspace.workspaceId)
                else if (option.title === 'Delete')
                    void this.onWorkspaceDeleteHandler(workspace.workspaceId)
            },
        })
        this.workspaceDropdowns.set(workspace.workspaceId, dropdown)
        menuAnchor.appendChild(dropdown.dom)
        menuAnchor.addEventListener('click', event => event.stopPropagation())

        const tagsEl = html`<div className="navigation-side-panel-row-tags"></div>` as HTMLDivElement

        if (workspace.tags?.length) {
            for (const tag of workspace.tags) {
                tagsEl.appendChild(html`<span className="navigation-side-panel-row-tag">${tag}</span>` as HTMLElement)
            }
        }

        const row = html`
            <button
                type="button"
                className=${`navigation-side-panel-row${isActive ? ' navigation-side-panel-row-active' : ''}`}
                onclick=${() => this.handleWorkspaceClick(workspace.workspaceId)}
            >
                <div className="navigation-side-panel-row-top">
                    <div className="navigation-side-panel-row-title">${workspace.name}</div>
                </div>
            </button>
        ` as HTMLButtonElement

        const rowTop = row.querySelector<HTMLDivElement>('.navigation-side-panel-row-top')

        if (!rowTop)
            return row

        rowTop.appendChild(menuAnchor)

        if (workspace.tags?.length)
            row.appendChild(tagsEl)

        return row
    }

    private handleWorkspaceClick(workspaceId: string): void {
        this.router.navigateTo(
            '/workspace/:workspaceId',
            {
                params: { workspaceId },
                shouldFetchData: true,
            },
        )
        workspaceStore.beginWorkspaceLoad(workspaceId)
    }

    private handleCreateNewWorkspaceClick = async (): Promise<void> => await this.workspaceService.createWorkspace({ name: 'New Workspace' })

    private onWorkspaceDeleteHandler = async (workspaceId: string): Promise<void> => await this.workspaceService.deleteWorkspace({ workspaceId })

    private onWorkspaceExportHandler = async (workspaceId: string): Promise<void> => {
        const token = await this.auth.getTokenSilently()

        if (!token)
            return

        const apiUrl = import.meta.env.VITE_API_URL
        window.open(`${apiUrl}/api/workspaces/${workspaceId}/export?token=${token}`, '_blank')
    }

    private onWorkspaceImportHandler = (workspaceId: string): void => {
        this.importTargetWorkspaceId = workspaceId
        this.importFileInput.value = ''
        this.importFileInput.click()
    }

    private handleImportFileSelected = async (event: Event): Promise<void> => {
        const input = event.target as HTMLInputElement
        const file = input.files?.[0]

        if (
            !file
            || !this.importTargetWorkspaceId
        )
            return

        const workspaceId = this.importTargetWorkspaceId
        this.importTargetWorkspaceId = null

        const token = await this.auth.getTokenSilently()

        if (!token)
            return

        const apiUrl = import.meta.env.VITE_API_URL
        const formData = new FormData()
        formData.append('file', file)

        try {
            const response = await fetch(
                `${apiUrl}/api/workspaces/${workspaceId}/import`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                    body: formData,
                },
            )

            if (!response.ok) {
                const error = await response.json()
                console.error('Workspace import failed:', error)

                return
            }

            const currentWorkspaceId = this.router.getCurrentRoute().routeParams.workspaceId

            if (currentWorkspaceId === workspaceId) {
                await this.workspaceService.getWorkspace({ workspaceId })
                await servicesStore.getData('assetService').loadWorkspaceAssets(workspaceId)
            }
        } catch (error) {
            console.error('Workspace import failed:', error)
        }
    }

    destroy = (): void => {
        this.importFileInput.removeEventListener('change', this.handleImportFileSelected)

        for (const unsubscribe of this.unsubscribers)
            unsubscribe()

        for (const dropdown of this.workspaceDropdowns.values())
            dropdown.destroy()

        this.workspaceDropdowns.clear()
        this.sidePanel.destroy()
        this.panelEl.remove()
    }
}

export const createNavigationSidePanel = (config: NavigationSidePanelConfig): NavigationSidePanelInstance => new NavigationSidePanel(config)
