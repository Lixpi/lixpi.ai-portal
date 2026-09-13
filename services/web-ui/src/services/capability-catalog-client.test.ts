import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

const getDataMock = vi.hoisted(() => vi.fn())
const getTokenSilentlyMock = vi.hoisted(() => vi.fn())
const userGetMock = vi.hoisted(() => vi.fn())

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: { getData: getDataMock },
}))

import { createDefaultCapabilityCatalogClient } from './capability-catalog-client.ts'

const auth = { getTokenSilently: getTokenSilentlyMock }
const userStore = { getData: userGetMock } as never

describe('createDefaultCapabilityCatalogClient', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getTokenSilentlyMock.mockResolvedValue('token-1')
        userGetMock.mockReturnValue('user-1')
    })

    it('builds a client with the given workspace and organization ids', () => {
        getDataMock.mockReturnValue(undefined)

        const client = createDefaultCapabilityCatalogClient(auth, userStore, 'workspace-1', 'org-1')

        expect(client).toBeDefined()
    })

    describe('transport.request', () => {
        it('delegates to the active NATS connection, threading the resolved token and workspace/org ids', async () => {
            const natsRequest = vi.fn(async () => ({ items: [] }))
            getDataMock.mockImplementation((key: string) => (key === 'nats' ? { request: natsRequest } : undefined))
            const client = createDefaultCapabilityCatalogClient(auth, userStore, 'workspace-1', 'org-1')

            const result = await client.search('goat')

            expect(natsRequest).toHaveBeenCalledTimes(1)
            const [subject, payload] = natsRequest.mock.calls[0]!
            expect(subject).toEqual(expect.any(String))
            expect(payload).toMatchObject({
                token: 'token-1',
                workspaceId: 'workspace-1',
                organizationId: 'org-1',
            })
            expect(result).toEqual({
                items: [],
                cursor: undefined,
            })
        })

        it('throws when no NATS connection is active', async () => {
            getDataMock.mockReturnValue(undefined)
            const client = createDefaultCapabilityCatalogClient(auth, userStore, 'workspace-1', 'org-1')

            await expect(client.search('goat')).rejects.toThrow('Capability catalog requires an active NATS connection')
        })
    })

    describe('getToken / getUserId wiring', () => {
        it('resolves the auth token through AuthService.getTokenSilently for every request', async () => {
            const natsRequest = vi.fn(async () => ({ items: [] }))
            getDataMock.mockImplementation((key: string) => (key === 'nats' ? { request: natsRequest } : undefined))
            const client = createDefaultCapabilityCatalogClient(auth, userStore, 'workspace-1', 'org-1')

            await client.search('goat')

            expect(getTokenSilentlyMock).toHaveBeenCalledTimes(1)
        })

        it('reads the current user id from userStore', () => {
            const client = createDefaultCapabilityCatalogClient(auth, userStore, 'workspace-1', 'org-1')
            const config = (client as unknown as { config: { getUserId: () => string } }).config

            expect(config.getUserId()).toBe('user-1')
            expect(userGetMock).toHaveBeenCalledWith('userId')
        })
    })
})
