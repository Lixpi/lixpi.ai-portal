import {
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { createRouterService } from '../routing/routerService.ts'
import { createRouterStore } from '../stores/routerStore.ts'
import { createRouteViewOutlet } from './routeViewOutlet.ts'

const createView = (label: string) => {
    const el = document.createElement('section')
    el.textContent = label

    return {
        el,
        destroy: vi.fn(() => el.remove()),
        mount: vi.fn(),
    }
}

describe('route view outlet', () => {
    it('replaces and destroys views when the route path changes', () => {
        const store = createRouterStore()
        const target = document.createElement('main')
        const home = createView('home')
        const workspace = createView('workspace')
        const onRouteChange = vi.fn()
        const routes = [
            {
                path: '/',
                createView: () => home,
            },
            {
                path: '/workspace/:workspaceId',
                createView: () => workspace,
            },
        ]
        const router = createRouterService({
            routes,
            store,
            window,
        })
        const outlet = createRouteViewOutlet({
            context: { router },
            onRouteChange,
            target,
            routes,
        })

        router.navigateTo('/', { shouldFetchData: false })
        expect(target.textContent).toBe('home')
        expect(home.mount).toHaveBeenCalledOnce()
        expect(onRouteChange).toHaveBeenLastCalledWith('/')

        router.navigateTo('/workspace/:workspaceId', { shouldFetchData: false })
        expect(home.destroy).toHaveBeenCalledOnce()
        expect(target.textContent).toBe('workspace')
        expect(workspace.mount).toHaveBeenCalledOnce()
        expect(onRouteChange).toHaveBeenLastCalledWith('/workspace/:workspaceId')

        outlet.destroy()
        expect(workspace.destroy).toHaveBeenCalledOnce()
        expect(target.children).toHaveLength(0)
    })
})
