import {
    type AssetDocumentRole,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

export type AssetDocumentSnapshot = {
    assetId: string
    role: AssetDocumentRole
    version: number
    doc: object
}

const snapshotKey = (
    assetId: string,
    role: AssetDocumentRole,
): string => `${assetId}#${role}`

export const assetDocumentsStore = createStore({
    initialState: new Map<string, AssetDocumentSnapshot>(),
    createMethods: store => ({
        set: (snapshot: AssetDocumentSnapshot): void =>
            void store.update(items => {
                const next = new Map(items)
                next.set(
                    snapshotKey(snapshot.assetId, snapshot.role),
                    structuredClone(snapshot),
                )

                return next
            }),
        setMany: (snapshots: AssetDocumentSnapshot[]): void => {
            if (snapshots.length === 0)
                return

            store.update(items => {
                const next = new Map(items)

                for (const snapshot of snapshots) {
                    next.set(
                        snapshotKey(snapshot.assetId, snapshot.role),
                        structuredClone(snapshot),
                    )
                }

                return next
            })
        },
        get: (assetId: string, role: AssetDocumentRole): AssetDocumentSnapshot | undefined =>
            store.get().get(
                snapshotKey(assetId, role),
            ),
        reset: (): void => void store.resetStore(),
    }),
})
