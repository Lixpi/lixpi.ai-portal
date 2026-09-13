import {
    LoadingStatus,
    NATS_SUBJECTS,
    type User,
} from '@lixpi/constants'

import {
    type UserStateStore,
} from '../stores/userStore.ts'

export type UserRequestClient = {
    request: (
        subject: string,
        payload: Record<string, unknown>,
    ) => Promise<unknown>
}

export type UserServiceConfig = {
    getToken: () => Promise<string | false>
    requestClient: UserRequestClient
    store: UserStateStore
}

export type WebClientUserService = {
    getUser: () => Promise<void>
}

class UserService implements WebClientUserService {
    constructor(private readonly config: UserServiceConfig) {}

    async getUser(): Promise<void> {
        this.config.store.setMetaValues({ loadingStatus: LoadingStatus.loading })

        try {
            const user = (await this.config.requestClient.request(
                NATS_SUBJECTS.USER_SUBJECTS.GET_USER,
                {
                    token: await this.config.getToken(),
                },
            )) as Partial<User>
            this.config.store.setDataValues(user)
            this.config.store.setMetaValues({ loadingStatus: LoadingStatus.success })
        } catch (error) {
            console.error('Failed to load user:', error)
            this.config.store.setMetaValues({ loadingStatus: LoadingStatus.error })
        }
    }
}

export const createUserService = (config: UserServiceConfig): WebClientUserService => new UserService(config)
