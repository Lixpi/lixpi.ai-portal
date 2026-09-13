import {
    WorkspaceCanvasSessionHub,
    normalizeWorkspaceCanvasState,
} from '@lixpi/canvas-components-lixpi-specific/shared'
import {
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'
import { createWorkspacePersistencePorts } from '$src/canvas-adapters/workspace-persistence.ts'

import {
    NATS_SUBJECTS,
    LoadingStatus,
    type CanvasState,
} from '@lixpi/constants'

const { WORKSPACE_SUBJECTS } = NATS_SUBJECTS

import { WORKSPACE_ROUTE_LOAD_REQUEST_TIMEOUT_MS } from '$src/services/requestTimeouts.ts'

import { servicesStore } from '$src/stores/servicesStore.ts'
import { workspacesStore } from '$src/stores/workspacesStore.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'

type WorkspaceRouter = Pick<WebClientRouterService, 'getRouteParams' | 'navigateTo'>

export type WorkspaceServiceConfig = {
    auth: AuthTokenProvider
    router: WorkspaceRouter
}

class WorkspaceService {
    readonly canvasSessions: WorkspaceCanvasSessionHub

    constructor(private readonly config: WorkspaceServiceConfig) {
        this.canvasSessions = new WorkspaceCanvasSessionHub(() => createWorkspacePersistencePorts(config))
    }

    public async getWorkspace({ workspaceId }: { workspaceId: string }): Promise<void> {
        if (this.config.router.getRouteParams().workspaceId !== workspaceId)
            return

        workspaceStore.beginWorkspaceLoad(workspaceId)

        try {
            const workspace: any = await servicesStore.getData('nats')!.request(
                WORKSPACE_SUBJECTS.GET_WORKSPACE,
                {
                    token: await this.config.auth.getTokenSilently(),
                    workspaceId,
                },
                WORKSPACE_ROUTE_LOAD_REQUEST_TIMEOUT_MS,
            )

            if (this.config.router.getRouteParams().workspaceId !== workspaceId)
                return

            if (workspace.error) {
                workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.error })
                workspaceStore.setDataValues({ error: workspace.error })

                return
            }

            const normalizedWorkspace = {
                ...workspace,
                canvasStateUpdatedAt: workspace.canvasStateUpdatedAt ?? workspace.updatedAt,
                canvasState: normalizeWorkspaceCanvasState(workspace.canvasState),
            }

            workspaceStore.setDataValues(normalizedWorkspace)
            workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        } catch (error) {
            if (this.config.router.getRouteParams().workspaceId !== workspaceId)
                return

            console.error('Failed to load workspace:', error)
            workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.error })
            workspaceStore.setDataValues({ error: error })
        }
    }

    public async getUserWorkspaces(): Promise<void> {
        try {
            workspacesStore.setMetaValues({ loadingStatus: LoadingStatus.loading })

            const response: any = await servicesStore.getData('nats')!.request(
                WORKSPACE_SUBJECTS.GET_USER_WORKSPACES,
                {
                    token: await this.config.auth.getTokenSilently(),
                },
            )

            // Ensure response is an array
            const workspaces = Array.isArray(response) ? response : []
            workspacesStore.setWorkspaces(workspaces)
            workspacesStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        } catch (error) {
            console.error('Failed to load user workspaces:', error)
            workspacesStore.setMetaValues({ loadingStatus: LoadingStatus.error })
            workspacesStore.setWorkspaces([])
        }
    }

    public async createWorkspace({ name }: { name: string }): Promise<void> {
        try {
            const workspace: any = await servicesStore.getData('nats')!.request(
                WORKSPACE_SUBJECTS.CREATE_WORKSPACE,
                {
                    token: await this.config.auth.getTokenSilently(),
                    name,
                },
            )

            if (workspace.error) {
                workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.error })
                workspaceStore.setDataValues({ error: workspace.error })

                return
            }

            const normalizedWorkspace = {
                ...workspace,
                canvasStateUpdatedAt: workspace.canvasStateUpdatedAt ?? workspace.updatedAt,
                canvasState: {
                    ...workspace.canvasState,
                    edges: workspace.canvasState?.edges ?? [],
                },
            }

            workspaceStore.setDataValues(normalizedWorkspace)
            workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.success })

            // Add workspace to the workspaces list in sidebar
            workspacesStore.addWorkspaces([{
                workspaceId: workspace.workspaceId,
                name: workspace.name,
                createdAt: workspace.createdAt,
                updatedAt: workspace.updatedAt,
            }])

            this.config.router.navigateTo(
                '/workspace/:workspaceId',
                {
                    params: { workspaceId: workspace.workspaceId },
                    shouldFetchData: true,
                },
            )
        } catch (error) {
            console.error('Failed to create workspace:', error)
            workspaceStore.setMetaValues({ loadingStatus: LoadingStatus.error })
            workspaceStore.setDataValues({ error: error })
        }
    }

    public async updateWorkspace({
        workspaceId,
        name,
    }: {
        workspaceId: string
        name: string
    }): Promise<void> {
        try {
            const result: any = await servicesStore.getData('nats')!.request(
                WORKSPACE_SUBJECTS.UPDATE_WORKSPACE,
                {
                    token: await this.config.auth.getTokenSilently(),
                    workspaceId,
                    name,
                },
            )

            if (!result.error) {
                workspaceStore.setDataValues({ name })
                workspacesStore.updateWorkspace(workspaceId, { name })
            }
        } catch (error) {
            console.error('Failed to update workspace:', error)
        }
    }

    public updateCanvasState({
        workspaceId,
        canvasState,
        persistViewport = false,
    }: {
        workspaceId: string
        canvasState: CanvasState
        persistViewport?: boolean
    }): void {
        this.canvasSessions.get(workspaceId).persistence.update(canvasState, persistViewport)
    }

    public async runCanvasMembershipMutation<Result>({
        workspaceId,
        mutation,
    }: {
        workspaceId: string
        mutation: () => Promise<Result>
    }): Promise<Result> {
        return await this.canvasSessions.get(workspaceId).persistence.runMembershipMutation(mutation)
    }

    public adoptAuthoritativeCanvasState({
        workspaceId,
        canvasState,
        canvasStateUpdatedAt,
    }: {
        workspaceId: string
        canvasState: CanvasState
        canvasStateUpdatedAt: number
    }): void {
        this.canvasSessions.get(workspaceId).persistence.adoptAuthoritative({
            canvasState,
            version: {
                updatedAt: canvasStateUpdatedAt,
                canvasStateUpdatedAt,
            },
        })
    }

    public async deleteWorkspace({ workspaceId }: { workspaceId: string }): Promise<void> {
        try {
            workspacesStore.setMetaValues({ loadingStatus: LoadingStatus.loading })

            const result: any = await servicesStore.getData('nats')!.request(
                WORKSPACE_SUBJECTS.DELETE_WORKSPACE,
                {
                    token: await this.config.auth.getTokenSilently(),
                    workspaceId,
                },
            )

            const {
                workspaceId: deletedWorkspaceId,
                success,
            } = result

            if (!success)
                throw new Error('Failed to delete workspace')

            const currentWorkspaceIndex = workspacesStore.getData().findIndex(workspace => workspace.workspaceId === deletedWorkspaceId)

            // Remove workspace from the sidebar
            workspacesStore.deleteWorkspace(deletedWorkspaceId)

            // Navigate to the next available workspace
            const currentWorkspaceId = this.config.router.getRouteParams().workspaceId
            const isDeletingCurrentlyOpenedWorkspace = currentWorkspaceId === deletedWorkspaceId
            const shiftedWorkspaceIndex = Math.max(currentWorkspaceIndex - 1, 0)
            const prevWorkspaceId = workspacesStore.getData()[shiftedWorkspaceIndex]?.workspaceId

            if (isDeletingCurrentlyOpenedWorkspace) {
                if (prevWorkspaceId) {
                    this.config.router.navigateTo(
                        '/workspace/:workspaceId',
                        {
                            params: { workspaceId: prevWorkspaceId },
                            shouldFetchData: true,
                        },
                    )
                } else
                    this.config.router.navigateTo('/', { params: {} })
            }

            workspacesStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        } catch (error) {
            console.error('Failed to delete workspace:', error)
            workspacesStore.setMetaValues({ loadingStatus: LoadingStatus.error })
        }
    }

    addTagToWorkspace({
        workspaceId,
        tagId,
        organizationId,
    }: {
        workspaceId: string
        tagId: string
        organizationId: string
    }) {
        // SocketService.emit({
        //     event: WORKSPACE_SUBJECTS.ADD_TAG_TO_WORKSPACE,
        //     data: {
        //         workspaceId,
        //         tagId,
        //         organizationId
        //     }
        // })
    }

    _addTagToWorkspaceResponse(data: any) {
        // if (data.error) {
        //     // Handle error case
        //     workspaceStore.setMetaValues({ isLoaded: true, errorLoading: data.error })
        // } else {
        //     // Assuming data contains updated workspace tags
        //     const updatedTags = data.tags
        //     // Update the tags in the workspace data
        //     workspaceStore.setDataValues({ tags: updatedTags })
        //     // Set metadata indicating successful loading
        //     workspaceStore.setMetaValues({ isLoaded: true, errorLoading: false })
        // }
    }

    removeTagFromWorkspace({
        workspaceId,
        tagId,
    }: {
        workspaceId: string
        tagId: string
    }) {
        // SocketService.emit({
        //     event: WORKSPACE_SUBJECTS.REMOVE_TAG_FROM_WORKSPACE,
        //     data: {
        //         workspaceId,
        //         tagId
        //     }
        // })
    }

    _removeTagFromWorkspaceResponse(data: any) {}
}

export default WorkspaceService
