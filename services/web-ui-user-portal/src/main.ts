import {
    createAuthClient,
    type AuthClientInstance,
} from '@lixpi/auth-client'
import { createWebClientService } from '@lixpi/web-client-service-factory'
import NatsService from '@lixpi/nats-service'

import { routes } from '$src/routes.ts'
import { createLayout } from '$src/views/layouts/layout.ts'
import '@lixpi/web-client-service-factory/styles/foundation'
import '$src/styles.scss'

const portalUrl = import.meta.env.VITE_AUTH0_REDIRECT_URI
type UserPortalDependencies = {
    auth: AuthClientInstance
    nats: NatsService
}

const application = createWebClientService<UserPortalDependencies>({
    createDependencies: async () => {
        const auth = createAuthClient({
            auth: {
                audience: import.meta.env.VITE_AUTH0_AUDIENCE,
                clientId: import.meta.env.VITE_AUTH0_CLIENT_ID,
                domain: import.meta.env.VITE_AUTH0_DOMAIN,
                redirectUri: portalUrl,
                logoutReturnTo: portalUrl,
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
            servers: [import.meta.env.VITE_NATS_SERVER],
            webSocket: true,
            name: 'web-client-user-portal',
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
    createView: ({
        dependencies: { auth },
        router,
    }) => createLayout({
        router,
        userStore: auth.userStore,
    }),
    destroyDependencies: async ({ nats }) => await nats.disconnect(),
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
    },
    onError: error => console.error('User portal failed to start', error),
})

void application.start()

export const shutdownApplication = (): Promise<void> => application.destroy()
