import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { createRouterStore } from '../stores/routerStore.ts'
import {
    createRouterService,
    type RouteDefinition,
} from './routerService.ts'

type Deferred = {
    promise: Promise<void>
    resolve: () => void
}

const createDeferred = (): Deferred => {
    let resolve!: () => void
    const promise = new Promise<void>(done => void (resolve = done))

    return {
        promise,
        resolve,
    }
}

const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 8; index++)
        await Promise.resolve()
}

beforeEach(() => window.history.replaceState({}, '', '/'))
afterEach(() => window.history.replaceState({}, '', '/'))

describe('web client router', () => {
    it('owns isolated route state and exposes route subscriptions', () => {
        const firstRouter = createRouterService({ routes: [{ path: '/' }] })
        const secondRouter = createRouterService({ routes: [{ path: '/' }] })
        const subscriber = vi.fn()
        const unsubscribe = firstRouter.subscribe(subscriber)

        firstRouter.navigateTo('/', {
            query: { panel: 'account' },
            shouldFetchData: false,
        })

        expect(firstRouter.getCurrentRoute().routeQuery).toEqual({ panel: 'account' })
        expect(secondRouter.getCurrentRoute().routeQuery).toEqual({})
        expect(subscriber).toHaveBeenLastCalledWith(expect.objectContaining({
            path: '/',
            routeQuery: { panel: 'account' },
        }))
        unsubscribe()
    })

    it('hydrates route parameters and query values from the browser URL', async () => {
        const store = createRouterStore()
        const routes: RouteDefinition[] = [{ path: '/users/:userId' }]
        const router = createRouterService({
            routes,
            store,
        })
        window.history.replaceState({}, '', '/users/user-1?tab=profile#details')

        await router.init()

        expect(store.getData('currentRoute')).toEqual({
            path: '/users/:userId',
            language: '',
            hash: 'details',
            routeParams: { userId: 'user-1' },
            routeQuery: { tab: 'profile' },
            isInitializationStep: true,
            shouldFetchData: false,
        })
        router.destroy()
    })

    it('writes programmatic navigation to browser history', async () => {
        const store = createRouterStore()
        const router = createRouterService({
            routes: [{ path: '/' }, { path: '/users/:userId' }],
            store,
        })
        await router.init()

        router.navigateTo('/users/:userId', {
            params: { userId: 'user 2' },
            query: { tab: 'security' },
            hash: 'sessions',
            shouldFetchData: false,
        })

        expect(window.location.pathname).toBe('/users/user%202')
        expect(window.location.search).toBe('?tab=security')
        expect(window.location.hash).toBe('#sessions')
        router.destroy()
    })

    it('uses an explicit fallback route for unknown browser paths', async () => {
        const store = createRouterStore()
        const onRouteChange = vi.fn()
        const router = createRouterService({
            fallbackPath: '/model-parameters',
            onRouteChange,
            routes: [
                { path: '/model-parameters' },
                { path: '/model-catalog' },
            ],
            store,
        })
        window.history.replaceState({}, '', '/unknown?filter=active#field')

        await router.init()

        expect(store.getData('currentRoute')).toEqual({
            path: '/model-parameters',
            language: '',
            hash: 'field',
            routeParams: {},
            routeQuery: { filter: 'active' },
            isInitializationStep: false,
            shouldFetchData: false,
        })
        expect(window.location.pathname).toBe('/model-parameters')
        expect(onRouteChange).toHaveBeenCalledWith(
            expect.objectContaining({ path: '/model-parameters' }),
            expect.objectContaining({ path: '/model-parameters' }),
        )
        router.destroy()
    })

    it('does not let a stale loader mark a newer route as fetched', async () => {
        const store = createRouterStore()
        const loads = new Map<string, Deferred>()
        const load = vi.fn(({ userId }: Record<string, unknown>) => {
            const deferred = createDeferred()
            loads.set(String(userId), deferred)

            return deferred.promise
        })
        const router = createRouterService({
            routes: [{
                path: '/users/:userId',
                load,
            }],
            store,
        })

        router.navigateTo('/users/:userId', { params: { userId: 'slow' } })
        router.navigateTo('/users/:userId', { params: { userId: 'active' } })

        loads.get('slow')?.resolve()
        await flushMicrotasks()
        expect(store.getData('currentRoute').shouldFetchData).toBe(true)

        loads.get('active')?.resolve()
        await flushMicrotasks()
        expect(store.getData('currentRoute').shouldFetchData).toBe(false)
        router.destroy()
    })
})
