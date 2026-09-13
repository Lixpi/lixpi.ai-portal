import {
    createAuth0Client,
    type Auth0Client,
} from '@auth0/auth0-spa-js'

import {
    type AuthStateStore,
    type WebClientAuthConfig,
    type WebClientAuthService,
} from './types.ts'

class Auth0Service implements WebClientAuthService {
    private auth0: Auth0Client | null = null

    constructor(
        private readonly config: WebClientAuthConfig,
        private readonly store: AuthStateStore,
    ) {}

    async init(): Promise<void> {
        this.store.setMetaValues({ isLoading: true })

        try {
            this.auth0 = await createAuth0Client({
                domain: this.config.domain,
                clientId: this.config.clientId,
                useRefreshTokens: true,
                useRefreshTokensFallback: true,
                cacheLocation: 'localstorage',
                authorizationParams: {
                    redirect_uri: this.config.redirectUri,
                    audience: this.config.audience,
                    scope: 'openid profile email',
                },
            })
            await this.updateAuthData()
        } catch (error) {
            this.setLoggedOut()

            throw error
        }
    }

    private getClient(): Auth0Client {
        if (!this.auth0)
            throw new Error('Auth0 client has not been initialized')

        return this.auth0
    }

    private async updateAuthData(): Promise<void> {
        const client = this.getClient()
        const searchParams = new URLSearchParams(window.location.search)

        if (
            searchParams.has('code')
            && searchParams.has('state')
        ) {
            await client.handleRedirectCallback()
            window.history.replaceState(
                {},
                document.title,
                window.location.pathname,
            )
        }

        const isAuthenticated = await client.isAuthenticated()

        if (!isAuthenticated) {
            this.setLoggedOut()

            return
        }

        const user = await client.getUser()
        this.store.setMetaValues({
            isLoading: false,
            isAuthenticated: true,
        })
        this.store.setDataValues({ user: user ?? null })
    }

    private setLoggedOut(): void {
        this.store.setMetaValues({
            isLoading: false,
            isAuthenticated: false,
        })
        this.store.setDataValues({ user: null })
    }

    async login(): Promise<void> {
        await this.getClient().loginWithRedirect({
            authorizationParams: {
                redirect_uri: this.config.redirectUri,
            },
        })
    }

    async logout(): Promise<void> {
        await this.getClient().logout({
            logoutParams: {
                returnTo: this.config.logoutReturnTo,
            },
        })
        this.setLoggedOut()
    }

    async getTokenSilently(forceRefresh = false): Promise<string | false> {
        try {
            return (await this.getClient().getTokenSilently(forceRefresh ? { cacheMode: 'off' } : undefined)) ?? false
        } catch {
            await this.login()

            return false
        }
    }
}

export const createAuth0Service = (
    config: WebClientAuthConfig,
    store: AuthStateStore,
): WebClientAuthService => new Auth0Service(config, store)
