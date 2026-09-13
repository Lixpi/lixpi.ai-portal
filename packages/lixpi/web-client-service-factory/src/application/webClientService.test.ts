import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { createRouterStore } from '../stores/routerStore.ts'
import { createWebClientService } from './webClientService.ts'

const createRouting = () => ({
    routes: [{ path: '/' }],
    store: createRouterStore(),
    window,
})

beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>'
    window.history.replaceState({}, '', '/')
})

describe('web client service', () => {
    it('passes initialized dependencies through the complete client lifecycle', async () => {
        const events: string[] = []
        const dependencies = { client: 'client-1' }
        const service = createWebClientService({
            createDependencies: () => {
                events.push('dependencies:create')

                return dependencies
            },
            createResources: [context => {
                expect(context.dependencies).toBe(dependencies)
                events.push('resource:create')

                return {
                    destroy: () => void events.push('resource:destroy'),
                }
            }],
            createView: context => {
                expect(context.dependencies).toBe(dependencies)
                events.push('view:create')

                return {
                    el: document.createElement('main'),
                    destroy: () => void events.push('view:destroy'),
                }
            },
            destroyDependencies: value => {
                expect(value).toBe(dependencies)
                events.push('dependencies:destroy')
            },
            initializeServices: context => {
                expect(context.dependencies).toBe(dependencies)
                const originalRouterInit = context.router.init.bind(context.router)
                const originalRouterDestroy = context.router.destroy.bind(context.router)
                vi.spyOn(context.router, 'init').mockImplementation(async () => {
                    events.push('router:init')
                    await originalRouterInit()
                })
                vi.spyOn(context.router, 'destroy').mockImplementation(() => {
                    events.push('router:destroy')
                    originalRouterDestroy()
                })
                events.push('services:initialize')
            },
            routing: createRouting(),
            shutdownServices: context => {
                expect(context.dependencies).toBe(dependencies)
                events.push('services:shutdown')
            },
            startServices: context => {
                expect(context.dependencies).toBe(dependencies)
                events.push('services:start')
            },
        })

        await service.start()
        expect(events).toEqual([
            'dependencies:create',
            'services:initialize',
            'resource:create',
            'view:create',
            'router:init',
            'services:start',
        ])

        const firstDestruction = service.destroy()
        expect(service.destroy()).toBe(firstDestruction)
        await firstDestruction
        expect(events).toEqual([
            'dependencies:create',
            'services:initialize',
            'resource:create',
            'view:create',
            'router:init',
            'services:start',
            'view:destroy',
            'resource:destroy',
            'router:destroy',
            'services:shutdown',
            'dependencies:destroy',
        ])
    })

    it('starts clients that do not inject dependencies', async () => {
        const startServices = vi.fn()
        const service = createWebClientService({
            createView: context => {
                expect(context.dependencies).toBeUndefined()

                return {
                    el: document.createElement('main'),
                    destroy: vi.fn(),
                }
            },
            routing: createRouting(),
            startServices,
        })

        await service.start()

        expect(startServices).toHaveBeenCalledWith(expect.objectContaining({
            dependencies: undefined,
        }))
        await service.destroy()
    })

    it('rolls back mounted state and injected dependencies when startup fails', async () => {
        const dependencies = { client: 'client-1' }
        const destroyDependencies = vi.fn()
        const destroyView = vi.fn()
        const onError = vi.fn()
        const shutdownServices = vi.fn()
        const service = createWebClientService({
            createDependencies: () => dependencies,
            createView: () => ({
                el: document.createElement('main'),
                destroy: destroyView,
            }),
            destroyDependencies,
            onError,
            routing: createRouting(),
            shutdownServices,
            startServices: () => {
                throw new Error('service startup failed')
            },
        })

        await service.start()

        expect(onError).toHaveBeenCalledWith(expect.objectContaining({
            message: 'service startup failed',
        }))
        expect(destroyView).toHaveBeenCalledOnce()
        expect(shutdownServices).toHaveBeenCalledOnce()
        expect(destroyDependencies).toHaveBeenCalledWith(dependencies)
    })
})
