import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { mountWebClientApplication } from './application.ts'

const createView = () => ({
    el: document.createElement('main'),
    destroy: vi.fn(),
})

beforeEach(() => void document.body.replaceChildren())

describe('web client application', () => {
    it('destroys the view, resources, and services once', async () => {
        const view = createView()
        const resource = { destroy: vi.fn() }
        const shutdown = vi.fn(async () => undefined)
        const application = mountWebClientApplication({
            target: document.body,
            createResources: [() => resource],
            createView: () => view,
            shutdown,
        })
        const first = application.destroy()

        expect(application.destroy()).toBe(first)
        await first
        expect(view.destroy).toHaveBeenCalledOnce()
        expect(resource.destroy).toHaveBeenCalledOnce()
        expect(shutdown).toHaveBeenCalledOnce()
    })

    it('cleans up every mounted part when mounting fails', () => {
        const resource = { destroy: vi.fn() }
        const view = createView()
        vi.spyOn(document.body, 'append').mockImplementation(() => {
            throw new Error('attach failed')
        })

        expect(() => mountWebClientApplication({
            target: document.body,
            createResources: [() => resource],
            createView: () => view,
        })).toThrow('Web client application mount failed: attach failed')
        expect(view.destroy).toHaveBeenCalledOnce()
        expect(resource.destroy).toHaveBeenCalledOnce()
    })
})
