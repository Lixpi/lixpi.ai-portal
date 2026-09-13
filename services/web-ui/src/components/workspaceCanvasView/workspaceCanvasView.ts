import {
    WorkspaceCanvasSurface,
    createWorkspaceCanvas,
} from '@lixpi/canvas-components-lixpi-specific/frontend/workspace'
import {
    uploadCanvasAsset,
    importCanvasAssetUrl,
} from '$src/canvas-adapters/asset-ingest.ts'
import {
    type WebClientRouterService,
} from '@lixpi/web-client-service-factory'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import { createWorkspaceCanvasHost } from '$src/canvas-adapters/workspace-canvas-host.ts'
import {
    type AssetService,
} from '$src/services/asset-service.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'
import { assetsStore } from '$src/stores/assetsStore.ts'
import { assetDocumentsStore } from '$src/stores/assetDocumentsStore.ts'
import { servicesStore } from '$src/stores/servicesStore.ts'
import {
    settings,
    colorPalette,
} from '$src/settings.ts'
import '@lixpi/canvas-components-lixpi-specific/styles/workspace'
import '$src/canvas-adapters/workspace-theme.scss'
import '@lixpi/canvas-components-lixpi-specific/styles/library-panels'

export type WorkspaceCanvasViewInstance = {
    el: HTMLElement
    destroy: () => void
}

export type WorkspaceCanvasViewConfig = {
    assetService: AssetService
    auth: AuthClientInstance
    router: WebClientRouterService
}

export const createWorkspaceCanvasView = ({
    assetService,
    auth,
    router,
}: WorkspaceCanvasViewConfig): WorkspaceCanvasViewInstance => {
    return new WorkspaceCanvasSurface(
        {
            panel: settings.rightSidePanel,
            modelMenuHoverBackground: settings.aiPromptInput.modelMenu.styles.triggerActiveBackground,
            palette: colorPalette,
            insertionWidth: settings.mediaNode.image.defaultInsertionWidth,
        },
        {
            document,
            readSnapshot: () => ({
                workspaceId: String(router.getCurrentRoute().routeParams.workspaceId ?? ''),
                loadedWorkspaceId: workspaceStore.getData('workspaceId'),
                organizationId: String(workspaceStore.getData('organizationId') ?? ''),
                loadingStatus: workspaceStore.getMeta('loadingStatus'),
                canvasState: workspaceStore.getData('canvasState'),
                assets: assetsStore.getAll(),
            }),
            readDocument: (assetId, role) => assetDocumentsStore.get(assetId, role)?.doc,
            subscriptions: [
                changed => router.subscribe(changed),
                changed => workspaceStore.subscribe(changed),
                changed => assetsStore.subscribe(changed),
                changed => assetDocumentsStore.subscribe(changed),
            ],
            session: workspaceId => {
                const sessions = servicesStore.getData('workspaceService')?.canvasSessions

                if (!sessions)
                    throw new Error('CANVAS_WRITE_COORDINATOR_UNAVAILABLE')

                return sessions.get(workspaceId)
            },
            membership: {
                attach: request => assetService.attach(request),
                detach: request => assetService.detach(request),
                now: Date.now,
            },
            ingest: {
                createDocument: request => assetService.create({
                    ...request,
                    primaryCategory: 'document',
                }),
                uploadFile: request => uploadCanvasAsset(auth, request),
                importUrl: request => importCanvasAssetUrl(auth, request),
                refreshAsset: async (assetId, workspaceId) => {
                    const result = await assetService.refresh(assetId, workspaceId)

                    return 'error' in result ? result : {}
                },
            },
            createId: () => crypto.randomUUID(),
            now: Date.now,
            publishTransient: (workspaceId, state) => {
                if (
                    router.getCurrentRoute().routeParams.workspaceId !== workspaceId
                    || workspaceStore.getData('workspaceId') !== workspaceId
                )
                    return

                workspaceStore.updateCanvasState(state)
            },
            synchronizeAssets: workspaceId => assetService.startWorkspaceSynchronization(workspaceId),
            storage: {
                get: key => localStorage.getItem(key),
                set: (key, value) => localStorage.setItem(key, value),
                remove: key => localStorage.removeItem(key),
            },
            setTimer: (callback, delay) => {
                const timer = setTimeout(callback, delay)

                return () => clearTimeout(timer)
            },
            onPageHide: callback => {
                window.addEventListener('pagehide', callback)

                return () => window.removeEventListener('pagehide', callback)
            },
            createRenderer: options => createWorkspaceCanvas(
                options,
                createWorkspaceCanvasHost({
                    assetService,
                    auth,
                }),
            ),
            reportError: (message, error) => console.error(message, error),
        },
    )
}
