import {
    LoadingStatus,
    type Asset,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type AssetStoreState = {
    loadingStatus: LoadingStatus
    workspaceId: string | null
    items: Map<string, Asset>
    error?: unknown
}

const initialState: AssetStoreState = {
    loadingStatus: LoadingStatus.idle,
    workspaceId: null,
    items: new Map(),
}

export const assetsStore = createStore({
    initialState,
    createMethods: store => ({
        setLoading: (workspaceId: string): void => void store.update(
            state => ({
                ...state,
                workspaceId,
                loadingStatus: LoadingStatus.loading,
            }),
        ),
        setAssets: (workspaceId: string, assets: Asset[]): void =>
            void store.update(
                state => ({
                    workspaceId,
                    loadingStatus: LoadingStatus.success,
                    items: new Map(
                        assets.map(asset => {
                            const existing = state.items.get(asset.assetId)

                            return [
                                asset.assetId,
                                structuredClone(
                                    existing
                                        && existing.revision > asset.revision
                                        ? existing
                                        : asset,
                                ),
                            ]
                        }),
                    ),
                }),
            ),
        upsert: (asset: Asset): void =>
            void store.update(state => {
                const existing = state.items.get(asset.assetId)

                if (
                    existing
                    && existing.revision > asset.revision
                )
                    return state

                const items = new Map(state.items)
                items.set(
                    asset.assetId,
                    structuredClone(asset),
                )

                return {
                    ...state,
                    items,
                }
            }),
        remove: (assetId: string): void =>
            void store.update(state => {
                const items = new Map(state.items)
                items.delete(assetId)

                return {
                    ...state,
                    items,
                }
            }),
        setError: (error: unknown): void => void store.update(
            state => ({
                ...state,
                error,
                loadingStatus: LoadingStatus.error,
            }),
        ),
        get: (assetId: string): Asset | undefined => store.get().items.get(assetId),
        getAll: (): Asset[] => [...store.get().items.values()],
        reset: (): void => void store.resetStore(),
    }),
})
