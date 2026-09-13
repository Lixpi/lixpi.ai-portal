import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    createRouterService,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'

const mocks = vi.hoisted(() => ({
    destroyCatalog: vi.fn(),
    destroyParameters: vi.fn(),
    mountCatalog: vi.fn(),
    mountParameters: vi.fn(),
}))

vi.mock('$src/views/modelCatalog/modelCatalogView.ts', () => ({
    createModelCatalogView: () => ({
        destroy: mocks.destroyCatalog,
        el: document.createElement('section'),
        mount: mocks.mountCatalog,
    }),
}))

vi.mock('$src/views/modelParameters/modelParametersView.ts', () => ({
    createModelParametersView: () => ({
        destroy: mocks.destroyParameters,
        el: document.createElement('section'),
        mount: mocks.mountParameters,
    }),
}))

import {
    MODEL_CATALOG_ROUTE_PATH,
    MODEL_PARAMETERS_ROUTE_PATH,
    routes,
} from '$src/routes.ts'
import { createLayout } from './layout.ts'

let router: WebClientRouterService

beforeEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    router = createRouterService({ routes })
})

describe('AI Model Registry layout', () => {
    it('mounts and destroys route views through the shared outlet', () => {
        const layout = createLayout({ router })
        document.body.append(layout.el)

        router.navigateTo(MODEL_PARAMETERS_ROUTE_PATH, { shouldFetchData: false })
        expect(mocks.mountParameters).toHaveBeenCalledOnce()

        router.navigateTo(MODEL_CATALOG_ROUTE_PATH, { shouldFetchData: false })
        expect(mocks.destroyParameters).toHaveBeenCalledOnce()
        expect(mocks.mountCatalog).toHaveBeenCalledOnce()

        layout.destroy()
        router.destroy()
        expect(mocks.destroyCatalog).toHaveBeenCalledOnce()
    })
})
