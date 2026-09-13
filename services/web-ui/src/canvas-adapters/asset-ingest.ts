import {
    type CanvasIngestReply,
    type CanvasUploadRequest,
} from '@lixpi/canvas-components-lixpi-specific/frontend/workspace'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'

const readReply = async (
    response: Response,
    fallbackError: string,
): Promise<CanvasIngestReply> => {
    const data = await response.json()

    if (!response.ok)
        return { error: data?.error || fallbackError }

    if (
        typeof data?.assetId !== 'string'
        || !['image', 'video', 'audio', 'document'].includes(data?.kind)
    )
        throw new Error('INVALID_ASSET_INGEST_REPLY')

    return {
        assetId: data.assetId,
        kind: data.kind,
    }
}

export const uploadCanvasAsset = async (
    auth: AuthTokenProvider,
    {
        workspaceId,
        file,
        onStart,
    }: CanvasUploadRequest & { file: File },
): Promise<CanvasIngestReply> => {
    const token = await auth.getTokenSilently()

    if (
        !token
        || !onStart()
    )
        return null

    const body = new FormData()
    body.append('file', file)
    const response = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/assets/workspaces/${workspaceId}`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body,
        },
    )

    return await readReply(response, 'Upload failed')
}

export const importCanvasAssetUrl = async (
    auth: AuthTokenProvider,
    {
        workspaceId,
        url,
        onStart,
    }: CanvasUploadRequest & { url: string },
): Promise<CanvasIngestReply> => {
    const token = await auth.getTokenSilently()

    if (
        !token
        || !onStart()
    )
        return null

    const response = await fetch(
        `${import.meta.env.VITE_API_URL || ''}/api/assets/workspaces/${workspaceId}/import-url`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url }),
        },
    )

    return await readReply(response, 'File URL import failed')
}
