import {
    type WebClientView,
} from '../application/application.ts'
import {
    type RouteDefinition,
    type WebClientRouterService,
} from '../routing/routerService.ts'

export type RouteViewContext = {
    router: WebClientRouterService
}

export type RouteViewDefinition<Context extends RouteViewContext = RouteViewContext> = RouteDefinition & {
    createView: (context: Context) => WebClientView
}

export type RouteViewOutletConfig<Context extends RouteViewContext = RouteViewContext> = {
    context: Context
    onRouteChange?: (path: string) => void
    routes: RouteViewDefinition<Context>[]
    target: HTMLElement
}

export type RouteViewOutletInstance = {
    destroy: () => void
}

class RouteViewOutlet<Context extends RouteViewContext> implements RouteViewOutletInstance {
    private activePath: string | null = null
    private activeView: WebClientView | null = null
    private readonly unsubscribe: () => void

    constructor(private readonly config: RouteViewOutletConfig<Context>) {
        this.unsubscribe = config.context.router.subscribe(currentRoute => this.render(currentRoute.path))
    }

    private render(path: string): void {
        this.config.onRouteChange?.(path)

        if (path === this.activePath)
            return

        const route = this.config.routes.find(candidate => candidate.path === path)

        if (!route)
            return

        this.activeView?.destroy()
        this.activeView = route.createView(this.config.context)
        this.activePath = path
        this.config.target.replaceChildren(this.activeView.el)
        this.activeView.mount?.()
    }

    destroy(): void {
        this.unsubscribe()
        this.activeView?.destroy()
        this.activeView = null
        this.activePath = null
        this.config.target.replaceChildren()
    }
}

export const createRouteViewOutlet = <Context extends RouteViewContext>(config: RouteViewOutletConfig<Context>): RouteViewOutletInstance =>
    new RouteViewOutlet(config)
