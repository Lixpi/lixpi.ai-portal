import { createAuth0Service } from './auth0Service.ts'
import { createLocalAuthService } from './localAuthService.ts'
import {
    type AuthStateStore,
    type SelectableAuthConfig,
    type WebClientAuthService,
} from './types.ts'

export const createAuthService = (
    config: SelectableAuthConfig,
    store: AuthStateStore,
): WebClientAuthService => {
    if (!config.mock?.enabled)
        return createAuth0Service(config, store)

    return createLocalAuthService(
        {
            audience: config.audience,
            clientId: config.mock.clientId ?? 'mock-client-id',
            domain: config.mock.domain,
            logoutReturnTo: config.logoutReturnTo,
            redirectUri: config.redirectUri,
            storageKey: config.mock.storageKey,
        },
        store,
    )
}
