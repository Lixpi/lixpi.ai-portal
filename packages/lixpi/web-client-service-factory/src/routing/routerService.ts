import {
    createRouterStore,
    type CurrentRoute,
    type RouterStore,
    type RouteValues,
} from '../stores/routerStore.ts'

export type RouteDefinition = {
    load?: (
        params: RouteValues,
        query: RouteValues,
    ) => Promise<void>
    path: string
}

export type NavigateOptions = {
    hash?: string
    isInitializationStep?: boolean
    language?: string
    params?: RouteValues
    query?: RouteValues
    shouldFetchData?: boolean
}

export type RouterServiceConfig = {
    fallbackPath?: string
    onRouteChange?: (
        currentRoute: CurrentRoute,
        route: RouteDefinition | undefined,
    ) => void
    routes: RouteDefinition[]
    store?: RouterStore
    window?: Window
}

export type RouterSubscriber = (currentRoute: CurrentRoute) => void

const routeValuesMatch = (
    left: RouteValues,
    right: RouteValues,
): boolean => {
    const leftEntries = Object.entries(left)
    const rightEntries = Object.entries(right)

    if (leftEntries.length !== rightEntries.length)
        return false

    return leftEntries.every(([key, value]) => String(value) === String(right[key]))
}

export class WebClientRouterService {
    private initialized = false
    private readonly routeDefinitions: RouteDefinition[]
    private readonly fallbackRoute: RouteDefinition | null
    private readonly onRouteChange: RouterServiceConfig['onRouteChange']
    private readonly store: RouterStore
    private readonly browserWindow: Window
    private unsubscribeRouter: (() => void) | null = null

    constructor(config: RouterServiceConfig) {
        this.routeDefinitions = config.routes
        this.fallbackRoute = config.fallbackPath
            ? this.routeDefinitions.find(route => route.path === config.fallbackPath) ?? null
            : null
        this.onRouteChange = config.onRouteChange
        this.store = config.store ?? createRouterStore()
        this.browserWindow = config.window ?? globalThis.window

        if (
            config.fallbackPath
            && !this.fallbackRoute
        )
            throw new Error(`Router fallback path ${config.fallbackPath} does not match a configured route`)
    }

    private handlePopState = (): void => void this.syncWithCurrentUrl()

    private subscribeToRouter(): void {
        this.unsubscribeRouter = this.store.subscribe(({ data }) => {
            const { currentRoute } = data
            this.onRouteChange?.(
                currentRoute,
                this.routeDefinitions.find(route => route.path === currentRoute.path),
            )

            if (currentRoute.isInitializationStep)
                return

            if (this.shouldUpdateBrowserHistory(currentRoute))
                this.updateBrowserHistory(currentRoute)
        })
    }

    private syncWithCurrentUrl(): void {
        const url = new URL(this.browserWindow.location.href)
        const segments = url.pathname.split('/').filter(Boolean).join('/')
        const routeMatch = this.findRouteByUrl(segments)

        if (
            !routeMatch
            && !this.fallbackRoute
        )
            return

        const {
            route,
            params,
        } = routeMatch ?? {
            route: this.fallbackRoute!,
            params: {},
        }
        this.navigateTo(
            route.path,
            {
                params,
                query: Object.fromEntries(url.searchParams),
                language: this.extractLanguage(url),
                hash: url.hash.slice(1),
                isInitializationStep: Boolean(routeMatch),
                shouldFetchData: Boolean(route.load),
            },
        )
    }

    private findRouteByUrl(urlPath: string): {
        params: RouteValues
        route: RouteDefinition
    } | null {
        const urlSegments = urlPath.replace(/\/$/, '').split('/').filter(Boolean)

        for (const route of this.routeDefinitions) {
            const routeSegments = route.path.replace(/\/$/, '').split('/').filter(Boolean)

            if (routeSegments.length !== urlSegments.length)
                continue

            const params: RouteValues = {}
            let matched = true

            for (let index = 0; index < routeSegments.length; index++) {
                const routeSegment = routeSegments[index]
                const urlSegment = urlSegments[index]

                if (routeSegment.startsWith(':'))
                    params[routeSegment.substring(1)] = decodeURIComponent(urlSegment)
                else if (routeSegment !== urlSegment) {
                    matched = false

                    break
                }
            }

            if (matched)
                return {
                    params,
                    route,
                }
        }

        return null
    }

    private async runDataLoaderIfNeeded(
        routeDefinition: RouteDefinition,
        params: RouteValues,
        query: RouteValues,
    ): Promise<void> {
        if (!routeDefinition.load)
            return

        await routeDefinition.load(params, query)
        const currentRoute = this.store.getData('currentRoute')

        if (
            currentRoute.path !== routeDefinition.path
            || !routeValuesMatch(currentRoute.routeParams, params)
            || !routeValuesMatch(currentRoute.routeQuery, query)
        )
            return

        this.markRouteDataFetched()
    }

    private shouldUpdateBrowserHistory(route: CurrentRoute): boolean {
        const currentUrl = new URL(this.browserWindow.location.href)
        const targetPath = this.composePath(route.path, route.routeParams)
        const targetQuery = this.composeQuery(route.routeQuery)

        return currentUrl.pathname !== targetPath
            || currentUrl.search !== targetQuery
            || currentUrl.hash.slice(1) !== route.hash
    }

    private updateBrowserHistory(route: CurrentRoute): void {
        this.browserWindow.history.pushState(
            {},
            '',
            this.composeUrl(route),
        )
    }

    private composeUrl(route: CurrentRoute): string {
        const path = this.composePath(route.path, route.routeParams)
        const query = this.composeQuery(route.routeQuery)
        const hash = route.hash ? `#${route.hash}` : ''

        return `${path}${query}${hash}`
    }

    private composePath(
        routePath: string,
        params: RouteValues,
    ): string {
        let path = routePath

        for (const [key, value] of Object.entries(params))
            path = path.replace(
                `:${key}`,
                encodeURIComponent(
                    String(value),
                ),
            )

        return path
    }

    private composeQuery(query: RouteValues): string {
        const entries = Object.entries(query).map(([
            key,
            value,
        ]): [string, string] => [key, String(value)])
        const queryString = new URLSearchParams(entries).toString()

        return queryString ? `?${queryString}` : ''
    }

    async init(): Promise<void> {
        if (this.initialized)
            return

        this.syncWithCurrentUrl()
        this.subscribeToRouter()
        this.browserWindow.addEventListener('popstate', this.handlePopState)
        this.initialized = true
    }

    navigateTo(
        path: string,
        options: NavigateOptions = {},
    ): void {
        const {
            params = {},
            query = {},
            language = '',
            hash = '',
            isInitializationStep = false,
            shouldFetchData = true,
        } = options
        const routerState = this.store.getData()
        const history = routerState.history.slice()

        if (
            !isInitializationStep
            && routerState.currentRoute.path
        )
            history.push(routerState.currentRoute)

        this.store.setDataValues({
            currentRoute: {
                path,
                language,
                hash,
                routeParams: params,
                routeQuery: query,
                isInitializationStep,
                shouldFetchData,
            },
            history,
        })

        const routeDefinition = this.routeDefinitions.find(route => route.path === path)

        if (
            routeDefinition?.load
            && shouldFetchData
        )
            void this.runDataLoaderIfNeeded(
                routeDefinition,
                params,
                query,
            )
    }

    shouldFetchRouteData(): boolean {
        return this.store.getData('currentRoute').shouldFetchData
    }

    markRouteDataFetched(): void {
        const currentRoute = this.store.getData('currentRoute')
        this.store.setDataValues({
            currentRoute: {
                ...currentRoute,
                shouldFetchData: false,
            },
        })
    }

    goBack(): void {
        const routerState = this.store.getData()

        if (routerState.history.length === 0)
            return

        const history = routerState.history.slice()
        const previousRoute = history.pop()

        if (!previousRoute)
            return

        this.store.setDataValues({
            currentRoute: previousRoute,
            history,
        })
    }

    extractLanguage(_url: URL): string {
        return ''
    }

    getRouteParams(): RouteValues {
        return this.store.getData('currentRoute').routeParams
    }

    getCurrentRoute(): CurrentRoute {
        return this.store.getData('currentRoute')
    }

    subscribe(subscriber: RouterSubscriber): () => void {
        return this.store.subscribe(({ data }) => subscriber(data.currentRoute))
    }

    destroy(): void {
        this.unsubscribeRouter?.()
        this.unsubscribeRouter = null
        this.browserWindow.removeEventListener('popstate', this.handlePopState)
        this.initialized = false
    }
}

export const createRouterService = (config: RouterServiceConfig): WebClientRouterService => new WebClientRouterService(config)
