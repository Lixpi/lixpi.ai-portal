import {
    createGentelellaApplicationShell,
    type GentelellaApplicationShellInstance,
} from '@lixpi/ui-kit-gentelella/components/application-shell'
import {
    createRouteViewOutlet,
    type RouteViewOutletInstance,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    type UserStateStore,
} from '@lixpi/auth-client'

import { routes } from '$src/routes.ts'

export type LayoutInstance = {
    readonly el: HTMLDivElement
    destroy: () => void
}

export type LayoutConfig = {
    router: WebClientRouterService
    userStore: UserStateStore
}

class Layout implements LayoutInstance {
    readonly el: HTMLDivElement

    private readonly shell: GentelellaApplicationShellInstance
    private readonly viewOutlet: RouteViewOutletInstance

    constructor({
        router,
        userStore,
    }: LayoutConfig) {
        this.shell = createGentelellaApplicationShell({
            brand: {
                mark: 'L',
                name: 'Lixpi Portal',
            },
            navigationGroups: [{
                label: 'Account',
                items: routes,
            }],
            onNavigate: path => router.navigateTo(path),
        })
        this.viewOutlet = createRouteViewOutlet({
            context: {
                router,
                userStore,
            },
            onRouteChange: path => this.shell.setActivePath(path),
            target: this.shell.contentEl,
            routes,
        })
        this.el = this.shell.el
    }

    destroy(): void {
        this.viewOutlet.destroy()
        this.shell.destroy()
    }
}

export const createLayout = (config: LayoutConfig): LayoutInstance => new Layout(config)
