import {
    type RouteViewContext,
    type RouteViewDefinition,
} from '@lixpi/web-client-service-factory'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'

import { createIntroPage } from '$src/components/introPage/introPage.ts'
import { createWorkspaceCanvasView } from '$src/components/workspaceCanvasView/workspaceCanvasView.ts'
import { servicesStore } from '$src/stores/servicesStore.ts'
import {
    type AssetService,
} from '$src/services/asset-service.ts'

export const INTRO_ROUTE_PATH = '/'
export const WORKSPACE_ROUTE_PATH = '/workspace/:workspaceId'

export type WebUiRouteContext = RouteViewContext & {
    assetService: AssetService
    auth: AuthClientInstance
}

export const loadWorkspaceRouteData = async (workspaceId: string): Promise<void> => {
    await servicesStore.getData('workspaceService').getWorkspace({ workspaceId })
    await servicesStore.getData('assetService').loadWorkspaceAssets(workspaceId)
}

export const routes: RouteViewDefinition<WebUiRouteContext>[] = [
    {
        path: INTRO_ROUTE_PATH,
        createView: () => createIntroPage(),
    },
    {
        path: WORKSPACE_ROUTE_PATH,
        createView: ({
            assetService,
            auth,
            router,
        }) => createWorkspaceCanvasView({
            assetService,
            auth,
            router,
        }),
        load: async params => void (await loadWorkspaceRouteData(
            String(params.workspaceId),
        )),
    },
]
