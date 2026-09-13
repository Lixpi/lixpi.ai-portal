import {
    LoadingStatus,
    type User,
} from '@lixpi/constants'
import { createUserStore } from '@lixpi/auth-client'
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest'

import { createUserInfoPage } from './userInfoPage.ts'

const userFixture: User = {
    userId: 'user-123',
    stripeCustomerId: 'customer-123',
    email: 'alex@example.com',
    name: 'Alex Rivera',
    givenName: 'Alex',
    familyName: 'Rivera',
    avatar: '',
    hasActiveSubscription: true,
    balance: '25',
    currency: 'USD',
    recentTags: [],
    organizations: ['organization-123'],
    createdAt: Date.UTC(2026, 0, 2),
    updatedAt: Date.UTC(2026, 0, 3),
}

describe('userInfoPage', () => {
    afterEach(() => void document.body.replaceChildren())

    it('renders loading, user, and error states from the shared store', () => {
        const store = createUserStore()
        const page = createUserInfoPage({ store })
        document.body.append(page.el)

        expect(page.el.textContent).toContain('Loading user information')

        store.setDataValues(userFixture)
        store.setMetaValues({ loadingStatus: LoadingStatus.success })

        expect(page.el.textContent).toContain('Alex Rivera')
        expect(page.el.textContent).toContain('alex@example.com')
        expect(page.el.textContent).toContain('organization-123')
        expect(page.el.textContent).toContain('Active')

        store.setMetaValues({ loadingStatus: LoadingStatus.error })

        expect(page.el.textContent).toContain('User information could not be loaded')
        page.destroy()
    })
})
