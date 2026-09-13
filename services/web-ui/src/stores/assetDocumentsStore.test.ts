import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest'

import {
    assetDocumentsStore,
    type AssetDocumentSnapshot,
} from './assetDocumentsStore.ts'

describe('assetDocumentsStore', () => {
    beforeEach(() => void assetDocumentsStore.reset())

    it('writes and reads a snapshot through domain methods that reuse base method names', () => {
        const snapshot: AssetDocumentSnapshot = {
            assetId: 'asset-1',
            role: 'conversation',
            version: 1,
            doc: { type: 'doc' },
        }

        assetDocumentsStore.set(snapshot)

        expect(assetDocumentsStore.get(
            snapshot.assetId,
            snapshot.role,
        )).toEqual(snapshot)
    })
})
