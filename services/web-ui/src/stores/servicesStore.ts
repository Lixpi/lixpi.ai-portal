import { LoadingStatus } from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type Meta = {
    loadingStatus: LoadingStatus
}

export type Services = {
    nats: any
    subscriptionService: any
    aiModelService: any
    projectService: any
    organizationService: any
    workspaceService: any
    assetService: any
}

const initialState: {
    meta: Meta
    data: Services
} = {
    meta: {
        loadingStatus: LoadingStatus.idle,
    },
    data: {
        nats: null,
        subscriptionService: null,
        aiModelService: null,
        projectService: null,
        organizationService: null,
        workspaceService: null,
        assetService: null,
    },
}

export const servicesStore = createStore({ initialState })
