import {
    createRouterService,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { routes } from '$src/routes.ts'
import { servicesStore } from '$src/stores/servicesStore.ts'

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

describe('web-ui routes', () => {
    const workspaceLoads = new Map<string, Deferred>()
    const getWorkspace = vi.fn(({ workspaceId }: { workspaceId: string }) => {
        const deferred = createDeferred()
        workspaceLoads.set(workspaceId, deferred)

        return deferred.promise
    })
    const loadWorkspaceAssets = vi.fn(async () => undefined)
    let router: WebClientRouterService

    beforeEach(() => {
        workspaceLoads.clear()
        getWorkspace.mockClear()
        loadWorkspaceAssets.mockClear()
        servicesStore.resetStore()
        servicesStore.setDataValues({
            workspaceService: { getWorkspace },
            assetService: { loadWorkspaceAssets },
        })
        router = createRouterService({ routes })
    })

    afterEach(() => void router.destroy())

    it('does not let a stale workspace load mark the active newer route as fetched', async () => {
        router.navigateTo('/workspace/:workspaceId', {
            params: { workspaceId: 'workspace-slow' },
            shouldFetchData: true,
        })
        router.navigateTo('/workspace/:workspaceId', {
            params: { workspaceId: 'workspace-active' },
            shouldFetchData: true,
        })

        workspaceLoads.get('workspace-slow')?.resolve()
        await flushMicrotasks()

        expect(router.getCurrentRoute().routeParams.workspaceId).toBe('workspace-active')
        expect(router.getCurrentRoute().shouldFetchData).toBe(true)

        workspaceLoads.get('workspace-active')?.resolve()
        await flushMicrotasks()

        expect(router.getCurrentRoute().routeParams.workspaceId).toBe('workspace-active')
        expect(router.getCurrentRoute().shouldFetchData).toBe(false)
    })

    it('loads workspace assets after the workspace itself resolves', async () => {
        router.navigateTo('/workspace/:workspaceId', {
            params: { workspaceId: 'workspace-slow' },
            shouldFetchData: true,
        })

        expect(getWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-slow' })
        expect(loadWorkspaceAssets).not.toHaveBeenCalled()

        workspaceLoads.get('workspace-slow')?.resolve()
        await flushMicrotasks()

        expect(loadWorkspaceAssets).toHaveBeenCalledExactlyOnceWith('workspace-slow')
    })
})
