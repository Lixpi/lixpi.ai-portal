import {
    type RouteViewContext,
    type RouteViewDefinition,
} from '@lixpi/web-client-service-factory'
import {
    type UserStateStore,
} from '@lixpi/auth-client'

import { createUserInfoPage } from '$src/views/userInfoPage/userInfoPage.ts'

export const USER_INFO_ROUTE_PATH = '/'

export type UserPortalRouteContext = RouteViewContext & {
    userStore: UserStateStore
}

export type UserPortalRouteDefinition = RouteViewDefinition<UserPortalRouteContext> & {
    label: string
}

export const routes: UserPortalRouteDefinition[] = [{
    path: USER_INFO_ROUTE_PATH,
    label: 'User information',
    createView: ({ userStore }) => createUserInfoPage({ store: userStore }),
}]
