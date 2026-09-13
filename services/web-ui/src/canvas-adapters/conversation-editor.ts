import {
    type EditorView,
} from 'prosemirror-view'
import {
    type CanvasConversationEditor,
    type CanvasConversationEditorMount,
    type CanvasConversationRunPorts,
    type CanvasConversationTransport,
    type CanvasGenerationRequest,
} from '@lixpi/canvas-components-lixpi-specific/frontend/workspace'
import { createDocumentHtml } from '@lixpi/ui-primitives/dom'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import { ProseMirrorEditor } from '$src/components/proseMirror/components/editor.ts'
import { USE_AI_CHAT_META } from '$src/components/proseMirror/plugins/aiChatThreadPlugin/aiChatThreadPluginConstants.ts'
import AiInteractionService from '$src/services/ai-interaction-service.ts'

type EditorOptions = ConstructorParameters<typeof ProseMirrorEditor>[0]

export type CanvasConversationEditorIntegration = Pick<
    EditorOptions,
    | 'aiChatThreadRenderContext'
    | 'assetService'
    | 'auth'
    | 'promptControlFactories'
    | 'promptReferencePreviewRenderer'
> & {
    register?: (
        threadId: string,
        view: EditorView,
    ) => () => void
}

class CanvasConversationEditorAdapter implements CanvasConversationEditor {
    private readonly editor: ProseMirrorEditor
    private unregister: (() => void) | null = null
    private destroyed = false

    constructor(
        private readonly request: CanvasConversationEditorMount,
        private readonly integration: CanvasConversationEditorIntegration,
    ) {
        const html = createDocumentHtml(request.container.ownerDocument)
        const version = request.thread.proseMirrorVersion
        this.editor = new ProseMirrorEditor({
            ...integration,
            editorMountElement: request.container,
            content: html`<div></div>` as HTMLDivElement,
            initialVal: request.thread.content,
            isDisabled: false,
            documentType: 'assetConversation',
            threadId: request.thread.threadId,
            proseMirrorAuthority: {
                organizationId: request.thread.organizationId,
                workspaceId: request.workspaceId,
                assetId: request.thread.threadId,
                role: 'conversation',
                baseVersion: typeof version === 'number'
                    && Number.isInteger(version)
                    && version >= 0
                    ? version
                    : 0,
                receiveOnly: true,
            },
            onEditorChange: request.onChange,
            onStreamingUpdate: request.onStreaming,
            onStreamEvent: request.onSegment,
            onAiChatSubmit: request.onSubmit,
            onAiChatStop: request.onStop,
            onPromptSubmit: () => {},
            onReceivingStateChange: request.onReceiving,
        })
    }

    activate(): void {
        if (
            this.destroyed
            || this.unregister
            || !this.integration.register
        )
            return

        try {
            const unregister = this.integration.register(this.request.thread.threadId, this.editor.editorView)

            if (this.destroyed)
                unregister()
            else
                this.unregister = unregister
        } catch (error) {
            try {
                this.destroy()
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Canvas editor registration failed')
            }

            throw error
        }
    }

    readContent(): object | undefined {
        return this.destroyed ? undefined : this.editor.editorView?.state.doc.toJSON()
    }

    submitPersisted(): void {
        if (this.destroyed)
            return

        const view = this.editor.editorView

        if (!view)
            return

        const threadId = this.request.thread.threadId
        let nodePos: number | undefined
        view.state.doc.descendants((node, pos) => {
            if (
                node.type.name === 'aiChatThread'
                && node.attrs.threadId === threadId
            ) {
                nodePos = pos

                return false
            }

            return true
        })

        if (nodePos !== undefined)
            view.dispatch(
                view.state.tr.setMeta(
                    USE_AI_CHAT_META,
                    {
                        threadId,
                        nodePos,
                    },
                ),
            )
    }

    destroy(): void {
        if (this.destroyed)
            return

        this.destroyed = true
        const errors: unknown[] = []

        try {
            this.unregister?.()
        } catch (error) {
            errors.push(error)
        }

        try {
            this.editor.destroy()
        } catch (error) {
            errors.push(error)
        }

        if (errors.length)
            throw new AggregateError(errors, 'Canvas conversation editor cleanup failed')
    }
}

class CanvasConversationTransportAdapter implements CanvasConversationTransport {
    private readonly service: AiInteractionService

    constructor(
        auth: AuthClientInstance,
        options: Parameters<CanvasConversationRunPorts['connect']>[0],
    ) {
        this.service = new AiInteractionService({
            auth,
            workspaceId: options.workspaceId,
            organizationId: options.thread.organizationId,
            conversationAssetId: options.thread.threadId,
            onError: options.onError,
            userStore: auth.userStore,
        })
    }

    async send(request: CanvasGenerationRequest): Promise<void> {
        await this.service.sendChatMessage(request)
    }
    async stop(): Promise<void> {
        await this.service.stopChatMessage()
    }
    disconnect(): void {
        this.service.disconnect()
    }
}

export const createCanvasConversationEditorPort = (integration: CanvasConversationEditorIntegration): CanvasConversationRunPorts['mountEditor'] =>
    request => new CanvasConversationEditorAdapter(request, integration)

export const createCanvasConversationTransport = (
    auth: AuthClientInstance,
    options: Parameters<CanvasConversationRunPorts['connect']>[0],
): CanvasConversationTransport => new CanvasConversationTransportAdapter(auth, options)
