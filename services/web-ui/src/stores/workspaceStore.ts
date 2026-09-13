import {
    createDefaultCanvasState,
    workspaceCanvasLoadPatch,
    workspaceCanvasStatePatch,
} from '@lixpi/canvas-components-lixpi-specific/shared'
import {
    LoadingStatus,
    type CanvasState,
    type Workspace,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type Meta = {
    loadingStatus: LoadingStatus
    isInEdit: boolean
    requiresSave: boolean
}

type WorkspaceData = Omit<Workspace, 'accessList'> & {
    error?: unknown
}

type WorkspaceStoreState = {
    meta: Meta
    data: WorkspaceData
}

const initialState: WorkspaceStoreState = {
    meta: {
        loadingStatus: LoadingStatus.idle,
        isInEdit: false,
        requiresSave: false,
    },
    data: {
        workspaceId: '',
        name: '',
        accessType: 'private',
        canvasState: createDefaultCanvasState(),
        createdAt: 0,
        canvasStateUpdatedAt: 0,
        updatedAt: 0,
    },
}

export const workspaceStore = createStore({
    initialState,
    createMethods: store => ({
        beginWorkspaceLoad: (workspaceId: string): void =>
            void store.update(state => {
                const canvas = workspaceCanvasLoadPatch()

                return {
                    ...state,
                    meta: {
                        ...state.meta,
                        loadingStatus: LoadingStatus.loading,
                        ...canvas.meta,
                    },
                    data: {
                        ...state.data,
                        workspaceId,
                        name: '',
                        error: null,
                        ...canvas.data,
                        createdAt: 0,
                        updatedAt: 0,
                    },
                }
            }),
        updateCanvasState: (canvasState: CanvasState): void =>
            void store.update(state => {
                const canvas = workspaceCanvasStatePatch(canvasState, 'local-intent')

                return {
                    ...state,
                    meta: {
                        ...state.meta,
                        ...canvas.meta,
                    },
                    data: {
                        ...state.data,
                        ...canvas.data,
                    },
                }
            }),
    }),
})
