import {
    describe,
    expect,
    it,
    beforeEach,
    vi,
} from 'vitest'
import { NATS_SUBJECTS } from '@lixpi/constants'

import { servicesStore } from '$src/stores/servicesStore.ts'
import { describeMedia } from './media-descriptor-service.ts'

const { MEDIA_DESCRIBE } = NATS_SUBJECTS.AI_INTERACTION_SUBJECTS

const getTokenSilently = vi.fn()
const auth = { getTokenSilently }

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: { getData: vi.fn() },
}))

const mockNatsRequest = (response: unknown) => {
    const request = vi.fn().mockResolvedValue(response)
    servicesStore.getData.mockReturnValue({ request } as never)

    return request
}

beforeEach(() => {
    vi.clearAllMocks()
    getTokenSilently.mockResolvedValue('token-1')
    servicesStore.getData.mockReturnValue(undefined as never)
})

// describeText was removed: text Asset descriptions are no longer requested
// from the client — the API describes text Assets itself. Only the media
// (image/video still) description path remains client-invoked.
describe('media-descriptor-service', () => {
    describe('describeMedia', () => {
        it('returns OFFLINE when the NATS service is missing', async () => {
            const result = await describeMedia(auth, {
                assetId: 'asset-image-1',
            })

            expect(result).toEqual({ error: 'OFFLINE' })
            expect(servicesStore.getData).toHaveBeenCalledWith('nats')
            expect(getTokenSilently).not.toHaveBeenCalled()
        })

        it('requests MEDIA_DESCRIBE with the asset id and token for image descriptors', async () => {
            const request = mockNatsRequest({
                summary: 'an image of a robot',
                entityTags: ['robot'],
            })
            const result = await describeMedia(auth, {
                assetId: 'asset-image-1',
                aiModel: 'vision-v2',
            })

            expect(result).toEqual({
                summary: 'an image of a robot',
                entityTags: ['robot'],
            })
            expect(request).toHaveBeenCalledTimes(1)
            expect(request).toHaveBeenCalledWith(MEDIA_DESCRIBE, {
                token: 'token-1',
                assetId: 'asset-image-1',
                aiModel: 'vision-v2',
            })
        })

        it('omits an aiModel field when no aiModel is supplied', async () => {
            const request = mockNatsRequest({ summary: 'no model hint needed' })

            await describeMedia(auth, {
                assetId: 'asset-image-2',
            })

            const payload = request.mock.calls[0]?.[1] as Record<string, unknown>
            expect(payload?.aiModel).toBeUndefined()
        })
    })
})
