import {
    type AiModel,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type Meta = {
    isLoading: boolean
    isLoaded: boolean
    errorLoading: boolean
}

export type Tag = {
    tagId: string
    name: string
    color: string
}

type Organization = {
    organizationId: string
    name: string
    tags: Tag[]
    availableModels: AiModel[]
    createdAt: number
    updatedAt: number
}

type OrganizationStoreState = {
    meta: Meta
    data: Organization
}

const initialState: OrganizationStoreState = {
    meta: {
        isLoading: false,
        isLoaded: false,
        errorLoading: false,
    },
    data: {
        organizationId: '',
        name: '',
        tags: [],
        availableModels: [],
        createdAt: 0,
        updatedAt: 0,
    },
}

export const organizationStore = createStore({
    initialState,
    createMethods: store => ({
        addTag: (tags: Record<string, Tag>): void =>
            void store.update(
                state => ({
                    ...state,
                    data: {
                        ...state.data,
                        tags: [
                            ...state.data.tags,
                            ...structuredClone(
                                Object.values(tags),
                            ),
                        ],
                    },
                }),
            ),
        updateTag: (updatedTag: Tag): void =>
            void store.update(
                state => ({
                    ...state,
                    data: {
                        ...state.data,
                        tags: state.data.tags.map(
                            tag => tag.tagId === updatedTag.tagId
                                ? structuredClone(updatedTag)
                                : tag,
                        ),
                    },
                }),
            ),
        removeTag: (tagId: string): void =>
            void store.update(
                state => ({
                    ...state,
                    data: {
                        ...state.data,
                        tags: state.data.tags.filter(tag => tag.tagId !== tagId),
                    },
                }),
            ),
    }),
})
