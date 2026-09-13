import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    createRouterService,
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import { createUserStore } from '@lixpi/auth-client'

const mocks = vi.hoisted(() => ({
    destroyUserInfo: vi.fn(),
}))

vi.mock('$src/views/userInfoPage/userInfoPage.ts', () => ({
    createUserInfoPage: () => {
        const el = document.createElement('section')
        el.dataset.view = 'user-info'

        return {
            destroy: mocks.destroyUserInfo,
            el,
        }
    },
}))

import {
    routes,
    USER_INFO_ROUTE_PATH,
} from '$src/routes.ts'
import { createLayout } from './layout.ts'

let router: WebClientRouterService

beforeEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    router = createRouterService({ routes })
})

describe('user portal layout', () => {
    it('mounts and destroys route views through the injected router', () => {
        const layout = createLayout({
            router,
            userStore: createUserStore(),
        })
        document.body.append(layout.el)

        router.navigateTo(USER_INFO_ROUTE_PATH, { shouldFetchData: false })

        expect(layout.el.querySelector('[data-view="user-info"]')).not.toBeNull()

        layout.destroy()
        router.destroy()
        expect(mocks.destroyUserInfo).toHaveBeenCalledOnce()
    })
})
