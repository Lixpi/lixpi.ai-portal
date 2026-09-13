import { configureUiKit } from '@lixpi/ui-kit'
import { createHelpTooltipProvider } from '@lixpi/ui-kit/components/help-tooltip'
import { createWebClientService } from '@lixpi/web-client-service-factory'
import NatsService from '@lixpi/nats-service'
import {
    createAuthClient,
    type AuthClientInstance,
} from '@lixpi/auth-client'

import SubscriptionService from '$src/services/subscription-service.ts'
import OrganizationService from '$src/services/organization-service.ts'
import AiModelService from '$src/services/ai-model-service.ts'
import WorkspaceService from '$src/services/workspace-service.ts'
import AssetService from '$src/services/asset-service.ts'

import { servicesStore } from '$src/stores/servicesStore.ts'

import { settings } from '$src/settings.ts'
import '@lixpi/ui-kit/styles/bubble-menu'
import '@lixpi/ui-kit/styles/canvas-node-footer'
import '@lixpi/ui-kit/styles/dropdown'
import '@lixpi/ui-kit/styles/help-tooltip'
import '@lixpi/ui-kit/styles/info-bubble'
import '@lixpi/ui-kit/styles/loading-placeholder'
import '@lixpi/ui-kit/styles/media-model-badge'
import '@lixpi/ui-kit/styles/preview'
import '@lixpi/ui-kit/styles/progress-ripple'
import '@lixpi/ui-kit/styles/progress-timeline'
import '@lixpi/ui-kit/styles/side-panel'
import '@lixpi/canvas-engine/styles/interaction'
import '@lixpi/web-client-service-factory/styles/foundation'

import { routes } from '$src/routes.ts'
import { createLayout } from '$src/views/layouts/layout.ts'
import '$src/sass/styles.scss'

const VITE_NATS_SERVER = import.meta.env.VITE_NATS_SERVER

type WebUiDependencies = {
    auth: AuthClientInstance
    nats: NatsService
}

configureUiKit(settings)

const application = createWebClientService<WebUiDependencies>({
    createDependencies: async () => {
        const auth = createAuthClient({
            auth: {
                domain: import.meta.env.VITE_AUTH0_DOMAIN,
                clientId: import.meta.env.VITE_AUTH0_CLIENT_ID,
                audience: import.meta.env.VITE_AUTH0_AUDIENCE,
                redirectUri: import.meta.env.VITE_AUTH0_REDIRECT_URI,
                logoutReturnTo: import.meta.env.VITE_AUTH0_LOGIN_URL,
                mock: {
                    domain: import.meta.env.VITE_MOCK_AUTH0_DOMAIN,
                    enabled: import.meta.env.VITE_MOCK_AUTH === 'true',
                },
            },
        })
        const session = await auth.initializeSession()

        if (
            auth.features.currentUser
            && !session
        )
            throw new Error('Current-user loading requires authentication')

        const nats = await NatsService.init({
            servers: [VITE_NATS_SERVER],
            webSocket: true,
            name: 'web-client',
            token: session?.accessToken,
            getToken: session?.getToken,
            onAuthError: session
                ? async () => void (await session.refreshToken())
                : undefined,
        })

        return {
            auth,
            nats,
        }
    },
    routing: { routes },
    createResources: [() => createHelpTooltipProvider({
        showDelayMs: settings.helpTooltip.providerShowDelayMs,
        root: document,
        shouldShow: trigger => trigger.getAttribute('aria-expanded') !== 'true',
    })],
    createView: ({
        dependencies: { auth },
        router,
    }) => createLayout({
        assetService: servicesStore.getData('assetService'),
        auth,
        router,
        workspaceService: servicesStore.getData('workspaceService'),
    }),
    destroyDependencies: async ({ nats }) => await nats.disconnect(),
    initializeServices: ({
        dependencies: {
            auth,
            nats,
        },
        router,
    }) => {
        const assetService = new AssetService({
            auth,
            userStore: auth.userStore,
        })
        const aiModelService = new AiModelService({
            auth,
            nats,
        })
        servicesStore.setDataValues({
            nats,
            subscriptionService: new SubscriptionService(),
            aiModelService,
            assetService,
            workspaceService: new WorkspaceService({
                auth,
                router,
            }),
            organizationService: new OrganizationService(),
        })
    },
    startServices: async ({ dependencies: {
        auth,
        nats,
    } }) => {
        if (auth.features.currentUser)
            await auth.loadCurrentUser({
                requestClient: {
                    request: (subject, payload) => nats.request(subject, payload),
                },
            })

        servicesStore.getData('organizationService')!.getOrganization({
            organizationId: auth.userStore.getData('organizations')[0],
        })
        servicesStore.getData('aiModelService')!.getAvailableAiModels()
        servicesStore.getData('workspaceService')!.getUserWorkspaces()
    },
    shutdownServices: async () => await servicesStore.getData('workspaceService')?.canvasSessions.close(),
    onError: error => console.error('Application failed to start', error),
})

void application.start()

export const shutdownApplication = (): Promise<void> => application.destroy()
