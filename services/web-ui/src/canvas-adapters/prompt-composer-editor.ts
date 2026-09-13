import {
    type AiPromptComposerConfig,
    type PromptComposerEditorRequest,
    type PromptComposerEditor,
} from '@lixpi/canvas-components-lixpi-specific/frontend/composer'
import {
    type PromptReferenceCatalogClient,
} from '$src/services/prompt-reference-catalog-client.ts'
import {
    type PromptReferencePreviewRenderer,
} from '@lixpi/canvas-components-lixpi-specific/frontend/context'
import {
    createDefaultPromptControlFactories,
    type PromptControlFactories,
} from '$src/components/proseMirror/promptControlFactories.ts'
import { ProseMirrorEditor } from '$src/components/proseMirror/components/editor.ts'
import { createDocumentHtml } from '@lixpi/ui-primitives/dom'
import {
    type AuthClientInstance,
} from '@lixpi/auth-client'
import {
    type AssetService,
} from '$src/services/asset-service.ts'

export type PromptComposerEditorOptions = {
    assetService: AssetService
    auth: AuthClientInstance
    controlFactories?: PromptControlFactories
    promptReferenceCatalog?: PromptReferenceCatalogClient
    promptReferencePreviewRenderer?: PromptReferencePreviewRenderer
}

class PromptComposerEditorAdapter implements PromptComposerEditor {
    private readonly editor: ProseMirrorEditor
    private destroyed = false

    constructor(
        request: PromptComposerEditorRequest,
        options: PromptComposerEditorOptions,
    ) {
        const html = createDocumentHtml(request.host.ownerDocument)
        this.editor = new ProseMirrorEditor({
            assetService: options.assetService,
            auth: options.auth,
            editorMountElement: request.host,
            content: html`<div></div>` as HTMLDivElement,
            initialVal: request.initialContent,
            isDisabled: false,
            documentType: 'aiPromptInput',
            threadId: request.threadId,
            onEditorChange: request.onContentChange,
            onAiChatSubmit: () => {},
            onAiChatStop: () => {},
            onPromptSubmit: request.onSubmit,
            promptControlFactories: options.controlFactories ?? createDefaultPromptControlFactories(),
            promptReferenceCatalog: options.promptReferenceCatalog,
            promptReferencePreviewRenderer: options.promptReferencePreviewRenderer,
        })
    }

    get editorView() {
        return this.destroyed ? null : (this.editor.editorView ?? null)
    }

    restoreContent(content: object): void {
        const view = this.editorView

        if (!view)
            throw new Error('AI_PROMPT_COMPOSER_NOT_READY')

        const restored = view.state.schema.nodeFromJSON(content)
        restored.check()
        view.dispatch(
            view.state.tr.replaceWith(
                0,
                view.state.doc.content.size,
                restored.content,
            ),
        )
        view.focus()
    }

    destroy(): void {
        if (this.destroyed)
            return

        this.destroyed = true
        this.editor.destroy()
    }
}

export const createPromptComposerEditorPort = (options: PromptComposerEditorOptions): AiPromptComposerConfig['mountEditor'] =>
    request => new PromptComposerEditorAdapter(request, options)
