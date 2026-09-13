import {
    NATS_SUBJECTS,
    type CapabilityModuleMeta,
    type CapabilityPromptReference,
    type PromptReferenceCatalogPage,
    type PromptReferenceCategory,
} from '@lixpi/constants'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'

import { servicesStore } from '$src/stores/servicesStore.ts'

export type PromptReferenceCatalogQuery = {
    category: PromptReferenceCategory
    query?: string
    cursor?: string
    limit?: number
}

export type PromptReferenceCatalogClient = {
    list: (query: PromptReferenceCatalogQuery) => Promise<PromptReferenceCatalogPage>
    listModules: (query?: string) => Promise<CapabilityModuleMeta[]>
    getModule: (moduleId: string) => Promise<{
        meta: CapabilityModuleMeta
        entry: CapabilityPromptReference
    }>
}

export const createPromptReferenceCatalogClient = (
    auth: AuthTokenProvider,
    workspaceId: string,
    organizationId: string,
): PromptReferenceCatalogClient => {
    const request = async <Response>(
        subject: string,
        payload: Record<string, unknown>,
    ): Promise<Response> => {
        const nats = servicesStore.getData('nats')

        if (!nats)
            throw new Error('Prompt-reference catalog requires an active NATS connection')

        const response = (await nats.request(
            subject,
            {
                token: await auth.getTokenSilently(),
                workspaceId,
                organizationId,
                ...payload,
            },
        )) as Response & { error?: string }

        if (response.error)
            throw new Error(response.error)

        return response
    }

    return {
        list: async query =>
            await request<PromptReferenceCatalogPage>(
                NATS_SUBJECTS.PROMPT_REFERENCE_SUBJECTS.LIST,
                {
                    category: query.category,
                    query: query.query?.normalize('NFKC').trim().toLocaleLowerCase('en-US') ?? '',
                    ...(query.cursor ? { cursor: query.cursor } : {}),
                    limit: query.limit ?? 20,
                },
            ),
        listModules: async (query = '') => {
            const response = await request<{ items: CapabilityModuleMeta[] }>(
                NATS_SUBJECTS.CAPABILITY_SUBJECTS.MODULES.LIST,
                { query: query.normalize('NFKC').trim().toLocaleLowerCase('en-US') },
            )

            return response.items
        },
        getModule: async moduleId =>
            await request<{
                meta: CapabilityModuleMeta
                entry: CapabilityPromptReference
            }>(NATS_SUBJECTS.CAPABILITY_SUBJECTS.MODULES.GET, { moduleId }),
    }
}
