import {
    LoadingStatus,
    type AiModel,
    type AiModelId,
    type AiModelsCatalogResponse,
    type DefaultAiModelCapability,
    type DefaultAiModelSelection,
    type MediaGenerationConfigMatrix,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type Meta = {
    loadingStatus: LoadingStatus
}

type AiModelsStoreState = {
    meta: Meta
    data: AiModel[]
    mediaGenerationConfigMatrix: MediaGenerationConfigMatrix
    defaultModels: DefaultAiModelSelection
}

const emptyDefaultModels: DefaultAiModelSelection = {
    reasoning: '' as AiModelId,
    image: '' as AiModelId,
    video: '' as AiModelId,
}

const initialState: AiModelsStoreState = {
    meta: {
        loadingStatus: LoadingStatus.idle,
    },
    data: [],
    mediaGenerationConfigMatrix: {
        version: 'media-generation-config-matrix-v1',
        groups: [],
    },
    defaultModels: emptyDefaultModels,
}

export const aiModelsStore = createStore({
    initialState,
    createMethods: store => ({
        getMediaGenerationConfigMatrix: (): MediaGenerationConfigMatrix => store.get().mediaGenerationConfigMatrix,
        getDefaultModelId: (capability: DefaultAiModelCapability): AiModelId => store.get().defaultModels[capability],
        addAiModels: (models: AiModel[] = []): void =>
            void store.update(
                state => ({
                    ...state,
                    data: [
                        ...structuredClone(models),
                        ...state.data,
                    ],
                }),
            ),
        setAiModels: (models: AiModel[] = []): void =>
            void store.update(
                state => ({
                    ...state,
                    data: structuredClone(models),
                    mediaGenerationConfigMatrix: structuredClone(initialState.mediaGenerationConfigMatrix),
                    defaultModels: structuredClone(emptyDefaultModels),
                }),
            ),
        setAiModelsCatalog: (catalog: AiModelsCatalogResponse): void =>
            void store.update(
                state => ({
                    ...state,
                    data: structuredClone(catalog.models as AiModel[]),
                    mediaGenerationConfigMatrix: structuredClone(catalog.mediaGenerationConfigMatrix ?? initialState.mediaGenerationConfigMatrix),
                    defaultModels: structuredClone(catalog.defaultModels ?? emptyDefaultModels),
                }),
            ),
    }),
})
