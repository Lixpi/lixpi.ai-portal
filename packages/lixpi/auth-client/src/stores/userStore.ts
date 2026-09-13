import {
    LoadingStatus,
    type User,
} from '@lixpi/constants'

import { createStore } from '@lixpi/web-client-service-factory'

export type UserStoreMeta = {
    loadingStatus: LoadingStatus
}

const emptyUser: User = {
    userId: '',
    stripeCustomerId: '',
    email: '',
    name: '',
    givenName: '',
    familyName: '',
    avatar: '',
    hasActiveSubscription: false,
    balance: '0',
    currency: '',
    recentTags: [],
    organizations: [],
    createdAt: 0,
    updatedAt: 0,
}

const initialState: {
    meta: UserStoreMeta
    data: User
} = {
    meta: {
        loadingStatus: LoadingStatus.idle,
    },
    data: emptyUser,
}

export const createUserStore = () => createStore({ initialState })

export type UserStateStore = ReturnType<typeof createUserStore>
