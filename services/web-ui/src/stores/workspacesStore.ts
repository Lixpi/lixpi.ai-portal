import {
    LoadingStatus,
    type WorkspaceMeta,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type Meta = {
    loadingStatus: LoadingStatus
}

type WorkspacesStoreState = {
    meta: Meta
    data: WorkspaceMeta[]
}

const initialState: WorkspacesStoreState = {
    meta: {
        loadingStatus: LoadingStatus.idle,
    },
    data: [],
}

export const workspacesStore = createStore({
    initialState,
    createMethods: store => ({
        addWorkspaces: (workspaces: WorkspaceMeta[] = []): void =>
            void store.update(
                state => ({
                    ...state,
                    data: [
                        ...structuredClone(workspaces),
                        ...state.data,
                    ],
                }),
            ),
        setWorkspaces: (workspaces: WorkspaceMeta[] = []): void =>
            void store.update(
                state => ({
                    ...state,
                    data: structuredClone(workspaces),
                }),
            ),
        deleteWorkspace: (workspaceId: string): void =>
            void store.update(
                state => ({
                    ...state,
                    data: state.data.filter(workspace => workspace.workspaceId !== workspaceId),
                }),
            ),
        updateWorkspace: (workspaceId: string, newValues: Partial<WorkspaceMeta>): void =>
            void store.update(
                state => ({
                    ...state,
                    data: state.data.map(
                        workspace => workspace.workspaceId === workspaceId
                            ? {
                                ...workspace,
                                ...structuredClone(newValues),
                            }
                            : workspace,
                    ),
                }),
            ),
    }),
})
