import { NATS_SUBJECTS } from '@lixpi/constants'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'

import { servicesStore } from '$src/stores/servicesStore.ts'

const { MEDIA_DESCRIBE } = NATS_SUBJECTS.AI_INTERACTION_SUBJECTS

export type DescribeMediaResult = {
    title?: string
    summary?: string
    entityTags?: string[]
    styleTags?: string[]
    error?: string
}

// Requests a compact VLM description of a single media still (an image's own
// file/final frame, or a video's representative frame/poster). Generated and
// uploaded media use the same path. The MP4 is never sent — the caller resolves
// the Asset ID. The API owns rendition selection and the descriptor VLM choice.
export const describeMedia = async (
    auth: AuthTokenProvider,
    {
        assetId,
        aiModel,
        workspaceId,
    }: {
        assetId: string
        aiModel?: string
        workspaceId?: string
    },
): Promise<DescribeMediaResult> => {
    const nats = servicesStore.getData('nats')

    if (!nats)
        return { error: 'OFFLINE' }

    return nats.request(
        MEDIA_DESCRIBE,
        {
            token: await auth.getTokenSilently(),
            assetId,
            ...(workspaceId ? { workspaceId } : {}),
            ...(aiModel ? { aiModel } : {}),
        },
    ) as Promise<DescribeMediaResult>
}

// Text Assets use the same subject. The API loads the authorized current Asset
// document and selects the requested text model; no document text crosses from
// canvas state or browser-maintained metadata.
