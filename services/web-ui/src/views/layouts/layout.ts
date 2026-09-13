// Root workspace shell: the navigation side panel plus the main pane that swaps
// between the workspace canvas and the intro splash based on the active route.
// Renderer: TypeScript `html` DOM, no framework runtime.

import { html } from '@lixpi/ui-primitives/dom'
import {
    createRouteViewOutlet,
    type RouteViewOutletInstance,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import {
    type AssetService,
} from '$src/services/asset-service.ts'
import { createNavigationSidePanel } from '$src/components/navigationSidePanel/index.ts'
import '$src/components/navigationSidePanel/navigation-side-panel.scss'

import { routes } from '$src/routes.ts'
import { settings } from '$src/settings.ts'
import '$src/views/layouts/layout.scss'

export type LayoutInstance = {
    el: HTMLElement
    destroy: () => void
}

export type LayoutConfig = {
    assetService: AssetService
    auth: AuthClientInstance
    router: WebClientRouterService
    workspaceService: {
        createWorkspace: (input: { name: string }) => Promise<void>
        deleteWorkspace: (input: { workspaceId: string }) => Promise<void>
        getWorkspace: (input: { workspaceId: string }) => Promise<void>
    }
}

class Layout implements LayoutInstance {
    readonly el: HTMLElement

    private readonly navigationSidePanel: ReturnType<typeof createNavigationSidePanel>
    private readonly previousHoverTransitionDuration: string
    private readonly viewOutlet: RouteViewOutletInstance

    constructor(config: LayoutConfig) {
        const contentEl = html`<div className="workspace-main-content"></div>` as HTMLDivElement
        const navigationSidePanelPaneEl = html`<div className="navigation-side-panel-pane"></div>` as HTMLDivElement
        this.el = html`
            <div className="layout-root">
                ${navigationSidePanelPaneEl}
                <div className="workspace-main-pane">
                    ${contentEl}
                </div>
            </div>
        ` as HTMLElement

        this.previousHoverTransitionDuration = document.documentElement.style.getPropertyValue('--default-hover-transition-duration')
        document.documentElement.style.setProperty('--default-hover-transition-duration', `${settings.hover.transitionDurationMs}ms`)

        this.navigationSidePanel = createNavigationSidePanel({
            auth: config.auth,
            paneEl: navigationSidePanelPaneEl,
            router: config.router,
            workspaceService: config.workspaceService,
        })
        this.viewOutlet = createRouteViewOutlet({
            context: {
                assetService: config.assetService,
                auth: config.auth,
                router: config.router,
            },
            target: contentEl,
            routes,
        })
    }

    destroy(): void {
        this.viewOutlet.destroy()
        this.navigationSidePanel.destroy()

        if (this.previousHoverTransitionDuration)
            document.documentElement.style.setProperty('--default-hover-transition-duration', this.previousHoverTransitionDuration)
        else
            document.documentElement.style.removeProperty('--default-hover-transition-duration')

        this.el.remove()
    }
}

export const createLayout = (config: LayoutConfig): LayoutInstance => new Layout(config)
