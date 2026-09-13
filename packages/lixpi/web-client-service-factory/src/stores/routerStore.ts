import { createStore } from './baseStore.ts'

export type RouteValues = Record<string, unknown>

export type CurrentRoute = {
    hash: string
    isInitializationStep: boolean
    language: string
    path: string
    routeParams: RouteValues
    routeQuery: RouteValues
    shouldFetchData: boolean
}

export type RouterState = {
    currentRoute: CurrentRoute
    history: CurrentRoute[]
}

export type RouterStoreMeta = Record<string, never>

const initialState: {
    meta: RouterStoreMeta
    data: RouterState
} = {
    meta: {},
    data: {
        currentRoute: {
            hash: '',
            isInitializationStep: false,
            language: 'en',
            path: '',
            routeParams: {},
            routeQuery: {},
            shouldFetchData: false,
        },
        history: [],
    },
}

export const createRouterStore = () => createStore({ initialState })

export type RouterStore = ReturnType<typeof createRouterStore>
