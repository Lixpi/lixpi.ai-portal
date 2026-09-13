// The model catalog the page renders, plus the filters applied to it. The view
// is a subscriber: every change to a filter, to the selected model, or to the
// loaded overview comes back through here.

import { LoadingStatus } from '@lixpi/constants'

import { createStore } from '@lixpi/web-client-service-factory'

import {
    type CatalogModel,
    type CatalogOverview,
    type ModelFile,
    type ProviderDirectory,
} from '$src/views/modelCatalog/types.ts'

export type StatusFilter =
    | 'all'
    | 'written-to-database'
    | 'missing-required-fields'
    | 'skipped-by-catalog-index'
    | 'drifting'

export type ModelCatalogFilters = {
    query: string
    provider: ProviderDirectory | 'all'
    status: StatusFilter
}

// The files behind the open model, loaded when the panel opens. One slot rather
// than a cache: only one model is open at a time.
export type OpenModelFiles = {
    key: string
    files: ModelFile[]
    loading: boolean
    error: string | null
}

type Meta = {
    loadingStatus: LoadingStatus
    // The last failure, kept so the page can say what went wrong instead of
    // rendering an empty table.
    error: string | null
    // A write in flight, so the detail panel can disable its controls.
    saving: boolean
    lastSaveMessage: string | null
}

// What a sync has left to do. Pressing the button marks every provider and every
// model as waiting, and each one clears as the run reports it done, so the page shows
// work being got through rather than a single spinner moving down the list.
export type SyncProgress = {
    running: boolean
    phase: 'fetching' | 'merging' | 'writing' | null
    pendingProviders: string[]
    // `provider/modelId` of every model the run has not finished with.
    pendingModels: string[]
    message: string | null
}

export const idleSyncProgress: SyncProgress = {
    running: false,
    phase: null,
    pendingProviders: [],
    pendingModels: [],
    message: null,
}

type Data = {
    overview: CatalogOverview | null
    syncProgress: SyncProgress
    filters: ModelCatalogFilters
    // `provider/modelId` of the model open in the detail panel.
    selectedModelKey: string | null
    openModelFiles: OpenModelFiles | null
    // Provider directories whose rows are folded away. A per-browser
    // convenience, so it is kept in localStorage rather than on the server.
    collapsedProviders: string[]
}

type ModelCatalogStoreMethods = {
    setFilters: (values?: Partial<ModelCatalogFilters>) => void
    toggleProviderCollapsed: (provider: ProviderDirectory) => void
}

export const modelKey = (model: CatalogModel): string => `${model.provider}/${model.modelId}`

const COLLAPSED_STORAGE_KEY = 'ai-model-registry:collapsed-providers'

const readCollapsedProviders = (): string[] => {
    try {
        const stored = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? '[]')

        return Array.isArray(stored) ? stored.map(String) : []
    } catch {
        return []
    }
}

const writeCollapsedProviders = (providers: string[]): void => {
    try {
        localStorage.setItem(
            COLLAPSED_STORAGE_KEY,
            JSON.stringify(providers),
        )
    } catch {
        // A browser with storage disabled still collapses, it just forgets.
    }
}

const initialState: {
    meta: Meta
    data: Data
} = {
    meta: {
        loadingStatus: LoadingStatus.idle,
        error: null,
        saving: false,
        lastSaveMessage: null,
    },
    data: {
        overview: null,
        syncProgress: idleSyncProgress,
        filters: {
            query: '',
            provider: 'all',
            status: 'all',
        },
        selectedModelKey: null,
        openModelFiles: null,
        collapsedProviders: readCollapsedProviders(),
    },
}

export const modelCatalogStore = createStore({
    initialState,
    createMethods: (store): ModelCatalogStoreMethods => ({
        setFilters: (values: Partial<ModelCatalogFilters> = {}): void =>
            void store.update(
                state => ({
                    ...state,
                    data: {
                        ...state.data,
                        filters: {
                            ...state.data.filters,
                            ...values,
                        },
                    },
                }),
            ),
        toggleProviderCollapsed: (provider: ProviderDirectory): void =>
            void store.update(state => {
                const collapsed = state.data.collapsedProviders.includes(provider)
                    ? state.data.collapsedProviders.filter(entry => entry !== provider)
                    : [...state.data.collapsedProviders, provider]
                writeCollapsedProviders(collapsed)

                return {
                    ...state,
                    data: {
                        ...state.data,
                        collapsedProviders: collapsed,
                    },
                }
            }),
    }),
})
