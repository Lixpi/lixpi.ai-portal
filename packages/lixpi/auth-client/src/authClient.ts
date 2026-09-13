import { createAuthService } from './auth/createAuthService.ts'
import {
    type AuthStateStore,
    type SelectableAuthConfig,
    type WebClientAuthService,
} from './auth/types.ts'
import { createAuthStore } from './stores/authStore.ts'
import {
    createUserStore,
    type UserStateStore,
} from './stores/userStore.ts'
import {
    createUserService,
    type UserRequestClient,
} from './users/userService.ts'
export type LoadCurrentUserConfig = {
    requestClient: UserRequestClient
}

export type AuthClientFeatures = {
    auth?: boolean
    currentUser?: boolean
}

export type AuthClientSession = {
    accessToken: string
    getToken: (forceRefresh?: boolean) => Promise<string | false>
    refreshToken: () => Promise<string | false>
}

type AuthClientBaseConfig = {
    authStore?: AuthStateStore
    userStore?: UserStateStore
}

export type AuthClientConfig = AuthClientBaseConfig & (
    | {
        auth: SelectableAuthConfig
        features?: AuthClientFeatures
    }
    | {
        auth?: never
        features: {
            auth: false
            currentUser: false
        }
    }
)

export type AuthClientInstance = WebClientAuthService & {
    readonly authStore: AuthStateStore
    readonly features: Required<AuthClientFeatures>
    readonly userStore: UserStateStore
    initializeSession: () => Promise<AuthClientSession | null>
    loadCurrentUser: (config: LoadCurrentUserConfig) => Promise<void>
}

class AuthClient implements AuthClientInstance {
    readonly authStore: AuthStateStore
    readonly features: Required<AuthClientFeatures>
    readonly userStore: UserStateStore

    private readonly authService: WebClientAuthService | null

    constructor(config: AuthClientConfig) {
        const authEnabled = config.features?.auth ?? true
        this.authStore = config.authStore ?? createAuthStore()
        this.features = {
            auth: authEnabled,
            currentUser: config.features?.currentUser ?? authEnabled,
        }
        this.userStore = config.userStore ?? createUserStore()
        this.authService = authEnabled
            && config.auth
            ? createAuthService(config.auth, this.authStore)
            : null
    }

    init = (): Promise<void> => this.authService
        ? this.authService.init()
        : Promise.resolve()

    login = (): Promise<void> => this.authService
        ? this.authService.login()
        : Promise.resolve()

    logout = (): Promise<void> => this.authService
        ? this.authService.logout()
        : Promise.resolve()

    getTokenSilently = (forceRefresh = false): Promise<string | false> => this.authService
        ? this.authService.getTokenSilently(forceRefresh)
        : Promise.resolve(false)

    initializeSession = async (): Promise<AuthClientSession | null> => {
        await this.init()

        if (!this.features.auth)
            return null

        const accessToken = await this.getTokenSilently()

        if (!accessToken)
            throw new Error('No auth token')

        return {
            accessToken,
            getToken: forceRefresh => this.getTokenSilently(forceRefresh),
            refreshToken: () => this.getTokenSilently(true),
        }
    }

    loadCurrentUser = (config: LoadCurrentUserConfig): Promise<void> =>
        this.features.currentUser
            ? createUserService({
                getToken: this.getTokenSilently,
                requestClient: config.requestClient,
                store: this.userStore,
            }).getUser()
            : Promise.resolve()
}

export const createAuthClient = (config: AuthClientConfig): AuthClientInstance => new AuthClient(config)
