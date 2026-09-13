import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest'
import { LoadingStatus } from '@lixpi/constants'

import { modelCatalogStore } from './modelCatalogStore.ts'

beforeEach(() => {
    localStorage.clear()
    modelCatalogStore.resetStore()
})

describe('model catalog store', () => {
    it('uses the shared base-store state helpers', () => {
        modelCatalogStore.setMetaValues({
            loadingStatus: LoadingStatus.loading,
        })
        modelCatalogStore.setDataValues({
            selectedModelKey: 'openai/gpt-image-1',
        })

        expect(modelCatalogStore.getMeta('loadingStatus')).toBe(LoadingStatus.loading)
        expect(modelCatalogStore.getData('selectedModelKey')).toBe('openai/gpt-image-1')

        modelCatalogStore.resetStore()
        expect(modelCatalogStore.getMeta('loadingStatus')).toBe(LoadingStatus.idle)
        expect(modelCatalogStore.getData('selectedModelKey')).toBeNull()
    })

    it('keeps its domain-specific filter and collapsed-provider methods', () => {
        modelCatalogStore.setFilters({ query: 'video' })
        modelCatalogStore.toggleProviderCollapsed('openai')

        expect(modelCatalogStore.getData('filters').query).toBe('video')
        expect(modelCatalogStore.getData('collapsedProviders')).toEqual(['openai'])
        expect(localStorage.getItem('ai-model-registry:collapsed-providers')).toBe('["openai"]')
    })
})
