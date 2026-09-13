// Root shell: the Gentelella sidebar plus the content pane that swaps between
// the parameter registry and the model catalog on the active route.
// Renderer: TypeScript `html` DOM, no framework runtime.

import {
    createGentelellaApplicationShell,
    type GentelellaApplicationShellInstance,
} from '@lixpi/ui-kit-gentelella/components/application-shell'
import { html } from '@lixpi/ui-primitives/dom'
import {
    createRouteViewOutlet,
    type RouteViewOutletInstance,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'

import { routes } from '$src/routes.ts'
import '$src/views/layouts/layout.scss'

export type LayoutInstance = {
    el: HTMLElement
    destroy: () => void
}

export type LayoutConfig = {
    router: WebClientRouterService
}

class Layout implements LayoutInstance {
    readonly el: HTMLElement

    private readonly shell: GentelellaApplicationShellInstance
    private readonly viewOutlet: RouteViewOutletInstance

    constructor({ router }: LayoutConfig) {
        this.shell = createGentelellaApplicationShell({
            brand: {
                mark: 'AI',
                name: 'Model Registry',
            },
            navigationGroups: [{
                label: 'Registry',
                items: routes,
            }],
            footerContent: html`<span className="registry-sidebar-note">Lixpi</span>`,
            onNavigate: path => router.navigateTo(path),
        })
        this.el = this.shell.el
        this.viewOutlet = createRouteViewOutlet({
            context: { router },
            onRouteChange: path => this.shell.setActivePath(path),
            routes,
            target: this.shell.contentEl,
        })
    }

    destroy(): void {
        this.viewOutlet.destroy()
        this.shell.destroy()
    }
}

export const createLayout = (config: LayoutConfig): LayoutInstance => new Layout(config)
