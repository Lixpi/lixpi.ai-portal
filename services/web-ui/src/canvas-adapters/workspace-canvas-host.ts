import {
    type WorkspaceCanvasHost,
} from '@lixpi/canvas-components-lixpi-specific/frontend/workspace'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import { WorkspaceMediaAdapter } from './workspace-media.ts'
import { createMediaModelBadge } from '@lixpi/ui-kit/components/media-model-badge'
import { createWorkspaceCanvasEditors } from './workspace-editors.ts'
import { createConversationProjectionFetch } from './conversation-projection.ts'
import { createCanvasConversationTransport } from './conversation-editor.ts'
import { subscribeCanvasMediaOperation } from './media-operation-events.ts'
import { createContextPreviewEnvironment } from './context-preview-environment.ts'
import { createExecutionTraceTimelineDetailAdapter } from '$src/components/executionTrace/index.ts'
import {
    applyMediaModelBadgeStyleProperties,
    resolveMediaModelBadgeConfig,
} from '$src/components/mediaModelBadge/mediaModelBadge.ts'
import {
    getAiModelIcon,
    getAiProviderIcon,
} from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiProviderIcons.ts'
import {
    capabilityArtifactFrontendRegistry,
    capabilityArtifactSharedRegistry,
    ensureCapabilityStyles,
} from '$src/installed-capabilities.ts'
import { settings } from '$src/settings.ts'
import {
    type AssetService,
} from '$src/services/asset-service.ts'
import { loadWorkspaceRouteData } from '$src/routes.ts'
import { createDefaultCapabilityCatalogClient } from '$src/services/capability-catalog-client.ts'
import { createPromptReferenceCatalogClient } from '$src/services/prompt-reference-catalog-client.ts'
import { describeMedia } from '$src/services/media-descriptor-service.ts'
import {
    cancelMediaGenerationRequest,
    getMediaGenerationRequest,
    replayMediaGenerationRequest,
    resolveMediaGenerationReference,
    startMediaGenerationVerification,
    stopAiChatMessageForThread,
} from '$src/services/ai-interaction-service.ts'
import { aiModelsStore } from '$src/stores/aiModelsStore.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'
import { assetsStore } from '$src/stores/assetsStore.ts'
import { assetDocumentsStore } from '$src/stores/assetDocumentsStore.ts'
import { extractContentFromProseMirror } from '$src/utils/prosemirrorText.ts'

export type WorkspaceCanvasHostConfig = {
    assetService: AssetService
    auth: AuthClientInstance
}

export const createWorkspaceCanvasHost = ({
    assetService,
    auth,
}: WorkspaceCanvasHostConfig): WorkspaceCanvasHost => {
    const apiBaseUrl = import.meta.env.VITE_API_URL || ''

    return {
        createId: () => crypto.randomUUID(),
        openExternalUrl: url => void window.open(
            url,
            '_blank',
            'noopener,noreferrer',
        ),
        onOpenCapabilityLibrary: callback => {
            const listener = (event: Event): void => void callback((event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId)
            window.addEventListener('lixpi:open-capability-library', listener)

            return () => window.removeEventListener('lixpi:open-capability-library', listener)
        },
        settings,
        editors: createWorkspaceCanvasEditors({
            assetService,
            auth,
        }),
        assets: {
            read: assetId => assetsStore.get(assetId),
            upsert: asset => assetsStore.upsert(asset),
            subscribe: changed => assetsStore.subscribe(changed),
            readDocument: (assetId, role) => assetDocumentsStore.get(assetId, role),
            create: request => assetService.create(request),
            get: (assetId, workspaceId) => assetService.get(assetId, workspaceId),
            refresh: (assetId, workspaceId) => assetService.refresh(assetId, workspaceId),
            loadWorkspaceAssets: workspaceId => assetService.loadWorkspaceAssets(workspaceId),
            ensureAssetsLoaded: assetIds => assetService.ensureAssetsLoaded(assetIds),
            updateMetadata: (
                assetId,
                revision,
                patch,
            ) => assetService.updateMetadata(
                assetId,
                revision,
                patch,
            ),
            changeScope: (
                assetId,
                revision,
                scope,
                ownerId,
            ) => assetService.changeScope(
                assetId,
                revision,
                scope,
                ownerId,
            ),
            attestSubjectIdentity: (
                assetId,
                revision,
                classification,
            ) => assetService.attestSubjectIdentity(
                assetId,
                revision,
                classification,
            ),
            reviewGeneratedOutput: request => assetService.reviewGeneratedOutput(request),
            list: query => assetService.list(query),
            resumeDocument: request => assetService.resumeDocument(request),
            detach: request => assetService.detach(request),
        },
        generation: {
            connect: options => createCanvasConversationTransport(auth, options),
            fetchConversation: createConversationProjectionFetch(assetService),
            subscribe: subscribeCanvasMediaOperation,
            get: request => getMediaGenerationRequest(auth, request),
            replay: request => replayMediaGenerationRequest(auth, request),
            cancel: request => cancelMediaGenerationRequest(auth, request),
            resolveReference: request => resolveMediaGenerationReference(auth, request),
            startVerification: request => startMediaGenerationVerification(auth, request),
            stopConversation: request => stopAiChatMessageForThread(auth, request),
            describeMedia: request => describeMedia(auth, request),
        },
        workspace: {
            organizationId: () => workspaceStore.getData('organizationId'),
            userId: () => auth.userStore.getData('userId'),
            loadingStatus: () => workspaceStore.getMeta('loadingStatus'),
            subscribe: changed => workspaceStore.subscribe(
                ({
                    meta,
                    data,
                }) => changed({
                    loadingStatus: meta.loadingStatus,
                    error: data.error,
                }),
            ),
            reload: loadWorkspaceRouteData,
        },
        models: {
            read: () => aiModelsStore.getData() ?? [],
            subscribe: changed => aiModelsStore.subscribe(changed),
            modelIcon: getAiModelIcon,
            providerIcon: getAiProviderIcon,
            createBadge: options => createMediaModelBadge(
                resolveMediaModelBadgeConfig(options),
            ),
            styleBadge: applyMediaModelBadgeStyleProperties,
        },
        capabilities: {
            frontend: capabilityArtifactFrontendRegistry,
            shared: capabilityArtifactSharedRegistry,
            ensureStyles: ensureCapabilityStyles,
            catalog: (workspaceId, organizationId) => createDefaultCapabilityCatalogClient(
                auth,
                auth.userStore,
                workspaceId,
                organizationId,
            ),
            promptCatalog: (workspaceId, organizationId) => createPromptReferenceCatalogClient(
                auth,
                workspaceId,
                organizationId,
            ),
        },
        media: new WorkspaceMediaAdapter({
            apiBaseUrl,
            getToken: () => auth.getTokenSilently(),
            getAsset: assetId => assetsStore.get(assetId),
            fetch,
        }),
        contextEnvironment: sources => createContextPreviewEnvironment(auth, sources),
        extractText: content => extractContentFromProseMirror(typeof content === 'string'
            || content && typeof content === 'object'
            ? content
            : '').text,
        traceDetail: createExecutionTraceTimelineDetailAdapter,
        storage: {
            getItem: key => localStorage.getItem(key),
            setItem: (key, value) => localStorage.setItem(key, value),
        },
        debugEnabled: () => {
            try {
                return localStorage.getItem('lixpi.debug.workspaceCanvas') === '1'
            } catch {
                return false
            }
        },
    }
}
