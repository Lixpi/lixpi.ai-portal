import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { createAuthStore } from '../stores/authStore.ts'
import { createLocalAuthService } from './localAuthService.ts'

const config = {
    audience: 'https://api.lixpi.test',
    clientId: 'mock-client-id',
    domain: 'localhost:3000',
    logoutReturnTo: 'http://localhost:3002',
    redirectUri: 'http://localhost:3002',
}

const makeToken = (expiresInSeconds: number): string => {
    const now = Math.floor(Date.now() / 1000)
    const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

    return `${encode({ alg: 'none' })}.${encode({ exp: now + expiresInSeconds })}.signature`
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('LocalAuth0 web client service', () => {
    it('uses a valid token from the application origin', async () => {
        const service = createLocalAuthService(config, createAuthStore())
        const token = makeToken(3600)
        localStorage.setItem('localauth0_token', token)

        await expect(service.getTokenSilently()).resolves.toBe(token)
    })

    it('refreshes a valid token when the caller requests a forced refresh', async () => {
        const service = createLocalAuthService(config, createAuthStore())
        localStorage.setItem('localauth0_token', makeToken(3600))
        const refresh = vi.spyOn(service as any, 'refreshTokenViaIframe').mockResolvedValue('fresh-token')

        await expect(service.getTokenSilently(true)).resolves.toBe('fresh-token')
        expect(refresh).toHaveBeenCalledTimes(1)
    })
})
