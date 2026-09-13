import {
    type RouteViewDefinition,
} from '@lixpi/web-client-service-factory'

import { modelCatalogService } from '$src/services/model-catalog-service.ts'
import {
    catalogIcon,
    slidersIcon,
} from '$src/views/layouts/icons.ts'
import { createModelCatalogView } from '$src/views/modelCatalog/modelCatalogView.ts'
import { createModelParametersView } from '$src/views/modelParameters/modelParametersView.ts'

export const MODEL_PARAMETERS_ROUTE_PATH = '/model-parameters'
export const MODEL_CATALOG_ROUTE_PATH = '/model-catalog'

export type RegistryRouteDefinition = RouteViewDefinition & {
    iconHtml: string
    label: string
    title: string
}

export const routes: RegistryRouteDefinition[] = [
    {
        path: MODEL_PARAMETERS_ROUTE_PATH,
        label: 'Model parameters',
        title: 'Model parameters',
        iconHtml: slidersIcon,
        createView: () => createModelParametersView(),
    },
    {
        path: MODEL_CATALOG_ROUTE_PATH,
        label: 'Model catalog',
        title: 'Model catalog',
        iconHtml: catalogIcon,
        createView: () => createModelCatalogView(),
        load: async () => await modelCatalogService.load(),
    },
]
