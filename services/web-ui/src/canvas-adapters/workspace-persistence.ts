import {
    NATS_SUBJECTS,
    type CanvasState,
    type Workspace,
} from '@lixpi/constants'
import {
    normalizeWorkspaceCanvasState,
    type CanvasPersistencePorts,
    type CanvasVersion,
    type WorkspaceCanvasSnapshot,
} from '@lixpi/canvas-components-lixpi-specific/shared'
import {
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import { WORKSPACE_ROUTE_LOAD_REQUEST_TIMEOUT_MS } from '$src/services/requestTimeouts.ts'
import { servicesStore } from '$src/stores/servicesStore.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'
import { workspacesStore } from '$src/stores/workspacesStore.ts'

type CanvasStateUpdateResponse = {
    success?: boolean
    workspaceId?: string
    updatedAt?: number
    canvasStateUpdatedAt?: number
    error?: string
    currentUpdatedAt?: number
    currentCanvasStateUpdatedAt?: number
}

const version = (
    updatedAt?: number,
    canvasStateUpdatedAt?: number,
): CanvasVersion => {
    return {
        ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
        ...(Number.isFinite(canvasStateUpdatedAt) ? { canvasStateUpdatedAt } : {}),
    }
}

type WorkspacePersistenceConfig = {
    auth: AuthTokenProvider
    router: Pick<WebClientRouterService, 'getRouteParams'>
}

const ownsActiveStore = (
    workspaceId: string,
    router: WorkspacePersistenceConfig['router'],
): boolean => {
    return workspaceStore.getData('workspaceId') === workspaceId
        && router.getRouteParams().workspaceId === workspaceId
}

export const createWorkspacePersistencePorts = ({
    auth,
    router,
}: WorkspacePersistenceConfig): CanvasPersistencePorts => {
    return {
        read: workspaceId => {
            if (!ownsActiveStore(workspaceId, router))
                return null

            return {
                canvasState: normalizeWorkspaceCanvasState(
                    workspaceStore.getData('canvasState'),
                ),
                version: version(
                    workspaceStore.getData('updatedAt'),
                    workspaceStore.getData('canvasStateUpdatedAt'),
                ),
            }
        },
        save: async request => {
            const result: CanvasStateUpdateResponse = await servicesStore.getData('nats')!.request(
                NATS_SUBJECTS.WORKSPACE_SUBJECTS.UPDATE_CANVAS_STATE,
                {
                    token: await auth.getTokenSilently(),
                    workspaceId: request.workspaceId,
                    canvasState: request.canvasState,
                    ...(request.persistViewport ? { persistViewport: true } : {}),
                    ...(Number.isFinite(request.expectedCanvasStateUpdatedAt) ? { expectedCanvasStateUpdatedAt: request.expectedCanvasStateUpdatedAt } : {}),
                },
            )
            const workspaceId = result.workspaceId ?? request.workspaceId

            if (result.error === 'STALE_CANVAS_STATE')
                return {
                    status: 'stale',
                    workspaceId,
                    current: version(result.currentUpdatedAt, result.currentCanvasStateUpdatedAt),
                }

            if (result.error)
                return {
                    status: 'error',
                    workspaceId,
                    error: new Error(result.error),
                }

            return {
                status: 'saved',
                workspaceId,
                version: version(result.updatedAt, result.canvasStateUpdatedAt),
            }
        },
        fetch: async workspaceId => {
            const result: Workspace & { error?: string } = await servicesStore.getData('nats')!.request(
                NATS_SUBJECTS.WORKSPACE_SUBJECTS.GET_WORKSPACE,
                {
                    token: await auth.getTokenSilently(),
                    workspaceId,
                },
                WORKSPACE_ROUTE_LOAD_REQUEST_TIMEOUT_MS,
            )

            if (result.error)
                throw new Error(result.error)

            if (result.workspaceId !== workspaceId)
                throw new Error('Workspace snapshot belongs to another workspace')

            const canvasState: CanvasState = normalizeWorkspaceCanvasState(result.canvasState)

            return {
                canvasState,
                version: version(result.updatedAt, result.canvasStateUpdatedAt ?? result.updatedAt),
            } satisfies WorkspaceCanvasSnapshot
        },
        publish: publication => {
            if (typeof publication.version?.updatedAt === 'number')
                workspacesStore.updateWorkspace(publication.workspaceId, { updatedAt: publication.version.updatedAt })

            if (!ownsActiveStore(publication.workspaceId, router))
                return

            if (publication.canvasState)
                workspaceStore.setDataValues({ canvasState: publication.canvasState })

            if (typeof publication.version?.updatedAt === 'number')
                workspaceStore.setDataValues({ updatedAt: publication.version.updatedAt })

            if (typeof publication.version?.canvasStateUpdatedAt === 'number')
                workspaceStore.setDataValues({ canvasStateUpdatedAt: publication.version.canvasStateUpdatedAt })

            if (workspaceStore.getMeta('requiresSave') !== publication.requiresSave)
                workspaceStore.setMetaValues({ requiresSave: publication.requiresSave })
        },
        reportError: error => console.error('Failed to update canvas state:', error),
    }
}
