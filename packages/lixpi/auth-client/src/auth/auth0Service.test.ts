import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

const mocks = vi.hoisted(() => ({
    getTokenSilently: vi.fn(),
    getUser: vi.fn(),
    handleRedirectCallback: vi.fn(),
    isAuthenticated: vi.fn(),
    loginWithRedirect: vi.fn(),
    logout: vi.fn(),
}))

vi.mock('@auth0/auth0-spa-js', () => ({
    createAuth0Client: vi.fn(async () => mocks),
}))

import { createAuth0Client } from '@auth0/auth0-spa-js'
import { createAuthStore } from '../stores/authStore.ts'
import { createAuth0Service } from './auth0Service.ts'

const config = {
    audience: 'https://api.lixpi.test',
    clientId: 'client-id',
    domain: 'auth.lixpi.test',
    logoutReturnTo: 'https://user-portal.lixpi.test',
    redirectUri: 'https://user-portal.lixpi.test',
}

beforeEach(() => {
    vi.resetAllMocks()
    mocks.isAuthenticated.mockResolvedValue(false)
    window.history.replaceState({}, '', '/')
})

describe('Auth0 web client service', () => {
    it('projects the authenticated Auth0 profile into the auth store', async () => {
        const store = createAuthStore()
        const service = createAuth0Service(config, store)
        const user = {
            sub: 'auth0|user-1',
            name: 'User One',
        }
        mocks.isAuthenticated.mockResolvedValue(true)
        mocks.getUser.mockResolvedValue(user)

        await service.init()

        expect(createAuth0Client).toHaveBeenCalledWith(expect.objectContaining({
            useRefreshTokens: true,
            useRefreshTokensFallback: true,
            cacheLocation: 'localstorage',
        }))
        expect(store.getMeta()).toEqual({
            isAuthenticated: true,
            isLoading: false,
        })
        expect(store.getData('user')).toEqual(user)
    })

    it('bypasses the SDK cache when a forced token refresh is requested', async () => {
        const service = createAuth0Service(config, createAuthStore())
        mocks.getTokenSilently.mockResolvedValue('fresh-token')
        await service.init()

        await expect(service.getTokenSilently(true)).resolves.toBe('fresh-token')
        expect(mocks.getTokenSilently).toHaveBeenCalledWith({ cacheMode: 'off' })
    })

    it('falls back to an Auth0 redirect when silent token acquisition fails', async () => {
        const service = createAuth0Service(config, createAuthStore())
        mocks.getTokenSilently.mockRejectedValue(new Error('login_required'))
        await service.init()

        await expect(service.getTokenSilently()).resolves.toBe(false)
        expect(mocks.loginWithRedirect).toHaveBeenCalledWith({
            authorizationParams: {
                redirect_uri: config.redirectUri,
            },
        })
    })
})
