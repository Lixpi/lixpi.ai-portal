import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { NATS_SUBJECTS } from '@lixpi/constants'

const getData = vi.hoisted(() => vi.fn())
const getTokenSilently = vi.hoisted(() => vi.fn())

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: { getData },
}))

import { createPromptReferenceCatalogClient } from './prompt-reference-catalog-client.ts'

const auth = { getTokenSilently }

beforeEach(() => {
    vi.clearAllMocks()
    getTokenSilently.mockResolvedValue('token-1')
})

describe('PromptReferenceCatalogClient', () => {
    it('normalizes category queries and preserves opaque pagination', async () => {
        const request = vi.fn().mockResolvedValue({
            items: [],
            cursor: 'next-page',
        })
        getData.mockReturnValue({ request })
        const client = createPromptReferenceCatalogClient(auth, 'workspace-1', 'organization-1')

        const page = await client.list({
            category: 'media',
            query: '  PoRTRAIT  ',
            cursor: 'current-page',
            limit: 5,
        })

        expect(page.cursor).toBe('next-page')
        expect(request).toHaveBeenCalledWith(NATS_SUBJECTS.PROMPT_REFERENCE_SUBJECTS.LIST, {
            token: 'token-1',
            workspaceId: 'workspace-1',
            organizationId: 'organization-1',
            category: 'media',
            query: 'portrait',
            cursor: 'current-page',
            limit: 5,
        })
    })

    it('fails before authentication when NATS is unavailable and surfaces API errors', async () => {
        getData.mockReturnValue(undefined)
        const client = createPromptReferenceCatalogClient(auth, 'workspace-1', 'organization-1')
        await expect(client.list({ category: 'capabilities' }))
            .rejects.toThrow('Prompt-reference catalog requires an active NATS connection')
        expect(getTokenSilently).not.toHaveBeenCalled()

        getData.mockReturnValue({ request: vi.fn().mockResolvedValue({ error: 'WORKSPACE_ACCESS_DENIED' }) })
        await expect(client.list({ category: 'capabilities' }))
            .rejects.toThrow('WORKSPACE_ACCESS_DENIED')
    })

    it('exposes direct module list and get clients on the module subjects', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ items: [{ moduleId: 'character-creator' }] })
            .mockResolvedValueOnce({
                meta: { moduleId: 'character-creator' },
                entry: {
                    capabilityId: 'global.character-creator',
                    kind: 'tool',
                },
            })
        getData.mockReturnValue({ request })
        const client = createPromptReferenceCatalogClient(auth, 'workspace-1', 'organization-1')

        await expect(client.listModules('  CHARACTER  ')).resolves.toEqual([{ moduleId: 'character-creator' }])
        await expect(client.getModule('character-creator')).resolves.toMatchObject({
            entry: {
                capabilityId: 'global.character-creator',
                kind: 'tool',
            },
        })
        expect(request).toHaveBeenNthCalledWith(
            1,
            NATS_SUBJECTS.CAPABILITY_SUBJECTS.MODULES.LIST,
            expect.objectContaining({
                query: 'character',
            }),
        )
        expect(request).toHaveBeenNthCalledWith(
            2,
            NATS_SUBJECTS.CAPABILITY_SUBJECTS.MODULES.GET,
            expect.objectContaining({
                moduleId: 'character-creator',
            }),
        )
    })
})
