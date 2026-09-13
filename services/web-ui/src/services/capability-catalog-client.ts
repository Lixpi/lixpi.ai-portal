import { CapabilityCatalogClient } from '@lixpi/capability-system/frontend'
import {
    type AuthTokenProvider,
    type UserStateStore,
} from '@lixpi/auth-client'

import { servicesStore } from '$src/stores/servicesStore.ts'

export * from '@lixpi/capability-system/frontend'

export const createDefaultCapabilityCatalogClient = (
    auth: AuthTokenProvider,
    userStore: UserStateStore,
    workspaceId: string,
    organizationId: string,
): CapabilityCatalogClient => {
    return new CapabilityCatalogClient({
        transport: {
            request: async <T>(subject: string, payload: Record<string, unknown>): Promise<T> => {
                const nats = servicesStore.getData('nats')

                if (!nats)
                    throw new Error('Capability catalog requires an active NATS connection')

                return await nats.request(subject, payload) as T
            },
            subscribe: (subject, listener) => {
                const nats = servicesStore.getData('nats')

                if (!nats)
                    throw new Error('Capability run events require an active NATS connection')

                return nats.subscribe(subject, listener)
            },
        },
        getToken: () => auth.getTokenSilently(),
        workspaceId,
        organizationId,
        getUserId: () => userStore.getData('userId') as string,
    })
}
