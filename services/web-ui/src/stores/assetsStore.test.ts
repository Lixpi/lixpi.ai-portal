import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest'

import { assetsStore } from './assetsStore.ts'

describe('assetsStore', () => {
    beforeEach(() => void assetsStore.reset())

    it('reads an asset without replacing the state reader used by the domain method', () => {
        expect(assetsStore.get('missing-asset')).toBeUndefined()
        expect(assetsStore.getAll()).toEqual([])
    })
})
