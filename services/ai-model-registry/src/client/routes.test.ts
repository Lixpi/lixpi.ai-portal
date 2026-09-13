import {
    createRouterService,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

const mocks = vi.hoisted(() => ({
    loadCatalog: vi.fn(async () => undefined),
}))

vi.mock('$src/services/model-catalog-service.ts', () => ({
    modelCatalogService: {
        load: mocks.loadCatalog,
    },
}))

import {
    MODEL_CATALOG_ROUTE_PATH,
    MODEL_PARAMETERS_ROUTE_PATH,
    routes,
} from '$src/routes.ts'

let router: WebClientRouterService

beforeEach(() => {
    mocks.loadCatalog.mockClear()
    document.title = 'AI Model Registry'
    window.history.replaceState({}, '', '/')
    router = createRouterService({
        fallbackPath: MODEL_PARAMETERS_ROUTE_PATH,
        onRouteChange: currentRoute => {
            const route = routes.find(candidate => candidate.path === currentRoute.path)
            document.title = route
                ? `${route.title} · AI Model Registry`
                : 'AI Model Registry'
        },
        routes,
    })
})

afterEach(() => {
    router.destroy()
    window.history.replaceState({}, '', '/')
})

describe('AI Model Registry routes', () => {
    it('redirects unknown paths to the model-parameters page', async () => {
        window.history.replaceState({}, '', '/unknown?reviewed=true#decision')

        await router.init()

        expect(router.getCurrentRoute()).toEqual(expect.objectContaining({
            hash: 'decision',
            path: MODEL_PARAMETERS_ROUTE_PATH,
            routeQuery: { reviewed: 'true' },
        }))
        expect(window.location.pathname).toBe(MODEL_PARAMETERS_ROUTE_PATH)
        expect(document.title).toBe('Model parameters · AI Model Registry')
    })

    it('loads the catalog and updates the document title', async () => {
        window.history.replaceState({}, '', MODEL_CATALOG_ROUTE_PATH)

        await router.init()
        await vi.waitFor(() => expect(mocks.loadCatalog).toHaveBeenCalledOnce())

        expect(router.getCurrentRoute().path).toBe(MODEL_CATALOG_ROUTE_PATH)
        expect(router.getCurrentRoute().shouldFetchData).toBe(false)
        expect(document.title).toBe('Model catalog · AI Model Registry')
    })
})
