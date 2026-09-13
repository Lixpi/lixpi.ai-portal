import { html } from '@lixpi/ui-primitives/dom'

import {
    type AuthStateStore,
    type LocalAuthConfig,
    type WebClientAuthService,
} from './types.ts'

const DEFAULT_STORAGE_KEY = 'localauth0_token'

class LocalAuthService implements WebClientAuthService {
    constructor(
        private readonly config: LocalAuthConfig,
        private readonly store: AuthStateStore,
    ) {}

    async init(): Promise<void> {
        this.store.setMetaValues({ isLoading: true })
        await this.updateAuthData()
    }

    private get storageKey(): string {
        return this.config.storageKey ?? DEFAULT_STORAGE_KEY
    }

    private get authorizationEndpoint(): string {
        const domain = this.config.domain.includes('://')
            ? this.config.domain
            : `http://${this.config.domain}`

        return `${domain}/authorize`
    }

    private async updateAuthData(): Promise<void> {
        try {
            if (window.location.hash.includes('access_token=')) {
                const params = new URLSearchParams(
                    window.location.hash.substring(1),
                )
                const accessToken = params.get('access_token')

                if (accessToken) {
                    localStorage.setItem(this.storageKey, accessToken)
                    window.history.replaceState(
                        {},
                        document.title,
                        window.location.pathname,
                    )
                }
            }

            const token = localStorage.getItem(this.storageKey)

            if (
                token
                && !this.isTokenExpired(token)
            ) {
                this.store.setMetaValues({
                    isLoading: false,
                    isAuthenticated: true,
                })
                this.store.setDataValues({
                    user: {
                        userId: 'local|test-user-001',
                        name: 'Test User',
                        email: 'test@local.dev',
                    },
                })

                return
            }
        } catch {
            localStorage.removeItem(this.storageKey)
        }

        this.setLoggedOut()
    }

    private setLoggedOut(): void {
        this.store.setMetaValues({
            isLoading: false,
            isAuthenticated: false,
        })
        this.store.setDataValues({ user: null })
    }

    async login(): Promise<void> {
        const query = new URLSearchParams({
            client_id: this.config.clientId,
            audience: this.config.audience,
            redirect_uri: this.config.redirectUri,
            scope: 'openid profile email',
            response_type: 'token',
            bypass: 'true',
        })
        window.location.href = `${this.authorizationEndpoint}?${query.toString()}`
    }

    async logout(): Promise<void> {
        localStorage.removeItem(this.storageKey)
        this.setLoggedOut()
        window.location.href = this.config.logoutReturnTo
    }

    private isTokenExpired(token: string): boolean {
        try {
            const parts = token.split('.')

            if (parts.length !== 3)
                return true

            const payload = JSON.parse(
                atob(parts[1]),
            ) as { exp?: number }

            if (!payload.exp)
                return true

            const now = Math.floor(Date.now() / 1000)

            return payload.exp <= now + 60
        } catch {
            return true
        }
    }

    private refreshTokenViaIframe(): Promise<string> {
        return new Promise((resolve, reject) => {
            const iframe = html`<iframe style=${{ display: 'none' }}></iframe>` as HTMLIFrameElement
            const callbackPath = new URL(this.config.redirectUri).pathname
            let loadCount = 0
            const cleanup = () => iframe.remove()

            iframe.addEventListener('load', () => {
                loadCount++

                try {
                    const iframeUrl = iframe.contentWindow?.location.href ?? ''

                    if (!iframeUrl.includes(callbackPath)) {
                        if (loadCount > 1) {
                            cleanup()
                            reject(
                                new Error('Iframe navigated without reaching callback'),
                            )
                        }

                        return
                    }

                    const hash = iframe.contentWindow?.location.hash?.substring(1)

                    if (!hash) {
                        cleanup()
                        reject(
                            new Error('No hash fragment in iframe redirect'),
                        )

                        return
                    }

                    const params = new URLSearchParams(hash)
                    const accessToken = params.get('access_token')
                    cleanup()

                    if (accessToken) {
                        localStorage.setItem(this.storageKey, accessToken)
                        resolve(accessToken)
                    } else
                        reject(
                            new Error('No access_token in iframe response'),
                        )
                } catch {
                    if (loadCount > 1) {
                        cleanup()
                        reject(
                            new Error('Cannot read iframe after multiple loads'),
                        )
                    }
                }
            })

            iframe.addEventListener('error', () => {
                cleanup()
                reject(
                    new Error('Iframe failed to load'),
                )
            })

            const query = new URLSearchParams({
                client_id: this.config.clientId,
                audience: this.config.audience,
                redirect_uri: this.config.redirectUri,
                scope: 'openid profile email',
                response_type: 'token',
                bypass: 'true',
                prompt: 'none',
            })
            document.body.appendChild(iframe)
            iframe.src = `${this.authorizationEndpoint}?${query.toString()}`
        })
    }

    async getTokenSilently(forceRefresh = false): Promise<string | false> {
        const token = localStorage.getItem(this.storageKey)

        if (
            !forceRefresh
            && token
            && !this.isTokenExpired(token)
        )
            return token

        try {
            return await this.refreshTokenViaIframe()
        } catch {
            await this.login()

            return false
        }
    }
}

export const createLocalAuthService = (
    config: LocalAuthConfig,
    store: AuthStateStore,
): WebClientAuthService => new LocalAuthService(config, store)
