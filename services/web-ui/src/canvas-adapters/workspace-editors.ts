import {
    type WorkspaceCanvasEditors,
} from '@lixpi/canvas-components-lixpi-specific/frontend/workspace'
import { createDocumentHtml } from '@lixpi/ui-primitives/dom'
import { ProseMirrorEditor } from '$src/components/proseMirror/components/editor.ts'
import { createDefaultPromptControlFactories } from '$src/components/proseMirror/promptControlFactories.ts'
import { mountReadOnlyAiChatThreadProjection } from '$src/components/proseMirror/readOnlyAiChatThreadRenderer.ts'
import { createCanvasConversationEditorPort } from './conversation-editor.ts'
import { createPromptComposerEditorPort } from './prompt-composer-editor.ts'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import {
    type AssetService,
} from '$src/services/asset-service.ts'

export type WorkspaceCanvasEditorsConfig = {
    assetService: AssetService
    auth: AuthClientInstance
}

const conversationControls = (createContextTray: () => HTMLDivElement) => {
    const {
        createCapabilityControls,
        ...controls
    } = createDefaultPromptControlFactories()

    return {
        ...controls,
        createContextTray,
    }
}

export const createWorkspaceCanvasEditors = ({
    assetService,
    auth,
}: WorkspaceCanvasEditorsConfig): WorkspaceCanvasEditors => {
    return {
        createConversation: integration =>
            createCanvasConversationEditorPort({
                assetService,
                auth,
                promptControlFactories: conversationControls(integration.createContextTray),
                promptReferencePreviewRenderer: integration.promptReferencePreviewRenderer,
                aiChatThreadRenderContext: { contextPreview: integration.contextPreview },
            }),
        createPrompt: integration =>
            createPromptComposerEditorPort({
                assetService,
                auth,
                controlFactories: {
                    ...createDefaultPromptControlFactories(),
                    mountMediaModeSwitch: integration.mountMediaModeSwitch,
                    mountModelMenuControl: integration.mountModelMenuControl,
                },
                promptReferenceCatalog: integration.promptReferenceCatalog,
                promptReferencePreviewRenderer: integration.promptReferencePreviewRenderer,
            }),
        mountAsset: request => {
            const html = createDocumentHtml(request.host.ownerDocument)

            return new ProseMirrorEditor({
                assetService,
                auth,
                editorMountElement: request.host,
                content: html`<div></div>` as HTMLDivElement,
                initialVal: request.content,
                isDisabled: false,
                documentType: request.documentType,
                proseMirrorAuthority: request.authority,
                onEditorChange: request.onChange,
                onStreamingUpdate: () => {},
                onAiChatSubmit: () => {},
                onAiChatStop: () => {},
            })
        },
        mountDocument: ({
            node,
            document,
            container,
            signal,
            onLeaseStateChange,
            workspaceId,
            onChange,
            createContextTray,
        }) => {
            const html = createDocumentHtml(container.ownerDocument)

            return new ProseMirrorEditor({
                assetService,
                auth,
                editorMountElement: container,
                content: html`<div></div>` as HTMLDivElement,
                initialVal: document.content,
                isDisabled: false,
                documentType: 'assetContent',
                threadId: null,
                proseMirrorAuthority: {
                    organizationId: document.organizationId,
                    workspaceId,
                    assetId: node.assetId,
                    role: 'content',
                    baseVersion: typeof document.proseMirrorVersion === 'number'
                        && Number.isInteger(document.proseMirrorVersion)
                        && document.proseMirrorVersion >= 0
                        ? document.proseMirrorVersion
                        : 0,
                    onLeaseStateChange,
                },
                onEditorChange: value => {
                    if (!signal.aborted)
                        onChange(value)
                },
                onStreamingUpdate: () => {},
                onAiChatSubmit: () => {},
                onAiChatStop: () => {},
                onPromptSubmit: () => {},
                promptControlFactories: conversationControls(createContextTray),
                onReceivingStateChange: () => {},
            })
        },
        mountCapability: ({
            container,
            document,
            schema,
            plugins,
            node,
            asset,
            version,
            signal,
            onLeaseStateChange,
            onContentChange,
            workspaceId,
            promptReferenceCatalog,
            promptReferencePreviewRenderer,
        }) => {
            const html = createDocumentHtml(container.ownerDocument)
            const editor = new ProseMirrorEditor({
                assetService,
                auth,
                editorMountElement: container,
                content: html`<div></div>` as HTMLDivElement,
                initialVal: document,
                isDisabled: false,
                documentType: 'capabilityArtifact',
                schema,
                plugins,
                enablePromptReferences: true,
                promptReferenceCatalog,
                promptReferencePreviewRenderer,
                proseMirrorAuthority: {
                    organizationId: asset.organizationId,
                    workspaceId,
                    assetId: node.assetId,
                    role: 'capabilityArtifact',
                    baseVersion: version,
                    onLeaseStateChange,
                },
                onEditorChange: () =>
                    queueMicrotask(() => {
                        if (!signal.aborted)
                            onContentChange()
                    }),
            })

            return {
                updateDocument: value => editor.updateDocument(value),
                destroy: () => editor.destroy(),
            }
        },
        mountHistory: request => mountReadOnlyAiChatThreadProjection({
            ...request,
            assetService,
            auth,
        }),
    }
}
