import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    LoadingStatus,
    NATS_SUBJECTS,
} from '@lixpi/constants'

import { createUserStore } from '../stores/userStore.ts'
import { createUserService } from './userService.ts'

let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => void (consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)))

afterEach(() => {
    consoleErrorSpy?.mockRestore()
    consoleErrorSpy = null
})

describe('current user service', () => {
    it('loads the user with the current access token', async () => {
        const store = createUserStore()
        const user = {
            userId: 'user-1',
            email: 'user@example.com',
            name: 'User One',
        }
        const request = vi.fn(async () => user)
        const service = createUserService({
            getToken: async () => 'access-token',
            requestClient: { request },
            store,
        })

        await service.getUser()

        expect(request).toHaveBeenCalledWith(
            NATS_SUBJECTS.USER_SUBJECTS.GET_USER,
            { token: 'access-token' },
        )
        expect(store.getData('userId')).toBe('user-1')
        expect(store.getMeta('loadingStatus')).toBe(LoadingStatus.success)
    })

    it('moves the store to the error state when the request fails', async () => {
        const store = createUserStore()
        const service = createUserService({
            getToken: async () => 'access-token',
            requestClient: {
                request: vi.fn(async () => {
                    throw new Error('request failed')
                }),
            },
            store,
        })

        await service.getUser()

        expect(store.getMeta('loadingStatus')).toBe(LoadingStatus.error)
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to load user:',
            expect.any(Error),
        )
    })
})
