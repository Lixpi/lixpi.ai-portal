import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
    describe,
    expect,
    it,
} from 'vitest'

import {
    formatMediaFileSize,
    stripMediaFileExtension,
} from '@lixpi/canvas-components-lixpi-specific/frontend/library'
import { withoutLayout } from '@lixpi/test-utils'

const expectSourceToContain = (source: string, snippet: string): void => void expect(withoutLayout(source).includes(withoutLayout(snippet)), `source should contain: ${snippet}`).toBe(true)

const expectSourceNotToContain = (source: string, snippet: string): void => void expect(withoutLayout(source).includes(withoutLayout(snippet)), `source should not contain: ${snippet}`).toBe(false)

const panelSource = readFileSync(resolve(import.meta.dirname, '../../packages/lixpi/canvas-components-lixpi-specific/src/frontend/library/media-library-panel.ts'), 'utf-8')
const panelStyles = readFileSync(resolve(import.meta.dirname, '../../packages/lixpi/canvas-components-lixpi-specific/src/frontend/library/workspace-library-panels.scss'), 'utf-8')
const canvasSource = [
    'workspace-canvas.ts',
    'workspace-canvas-libraries.ts',
    'workspace-generated-output-details.ts',
].map(filename => readFileSync(resolve(import.meta.dirname, `../../packages/lixpi/canvas-components-lixpi-specific/src/frontend/workspace/${filename}`), 'utf-8')).join('\n')
const workspaceCanvasViewSource = readFileSync(resolve(import.meta.dirname, '../components/workspaceCanvasView/workspaceCanvasView.ts'), 'utf-8')
    + readFileSync(resolve(import.meta.dirname, '../../packages/lixpi/canvas-components-lixpi-specific/src/frontend/workspace/workspace-canvas-surface.ts'), 'utf-8')

describe('Media Library panel contract', () => {
    it('is an embedded renderer the right side panel hosts, not a standalone drawer', () => {
        expectSourceToContain(panelSource, 'media-library-panel-embedded')
        expectSourceToContain(panelSource, 'mountInto(hostEl: HTMLElement): void')
        // No browse-scope filter control — the panel always shows everything available.
        expectSourceNotToContain(panelSource, 'media-library-scope-select')
        // No standalone modal chrome, category tab strip, or backdrop.
        expectSourceNotToContain(panelSource, 'MEDIA_LIBRARY_CATEGORY')
        expectSourceNotToContain(panelSource, 'media-library-category-tabs')
        expectSourceNotToContain(panelSource, 'media-library-backdrop')
        expectSourceNotToContain(panelSource, 'role="tablist"')
    })

    it('loads cataloged Assets and excludes conversation and Artifact records', () => {
        expectSourceToContain(panelSource, 'workspaceId: this.options.workspaceId,')
        expectSourceToContain(panelSource, 'limit: 100,')
        expectSourceToContain(panelSource, "asset.primaryCategory !== 'conversation' && asset.primaryCategory !== 'capabilityArtifact'")
        expectSourceToContain(panelSource, 'for (const asset of this.allAssets)')
    })

    it('removes the Extract-new button and its color entirely', () => {
        expectSourceNotToContain(panelSource, 'Extract new')
        expectSourceNotToContain(panelSource, 'media-library-footer-new-btn')
        expectSourceNotToContain(panelSource, 'onOpenExtractionTab')
        expectSourceNotToContain(panelStyles, 'media-library-footer-new-btn')
        // The deprecated "Create new element button" green must never reappear.
        expectSourceNotToContain(panelStyles, '85, 150, 124')
        expectSourceNotToContain(panelStyles, '#55967c')
    })

    it('keeps browsing rows concise while retaining complete inspector details', () => {
        expectSourceToContain(panelSource, 'media-library-browser-intro')
        expectSourceToContain(panelSource, 'media-library-panel-images')
        expectSourceToContain(panelSource, 'capability-library-section-items')
        expectSourceToContain(panelSource, 'capability-library-row-thumb')
        expectSourceToContain(panelSource, 'capability-library-row-action capability-library-row-action-primary')
        expectSourceNotToContain(panelSource, 'capability-library-row-use')
        expectSourceToContain(panelStyles, '.capability-library-row-action {')
        expectSourceToContain(panelStyles, '.capability-library-row-action-primary {')
        expectSourceNotToContain(panelSource, 'media-library-item-thumb')
        expectSourceNotToContain(panelSource, 'media-library-item-info')
        expectSourceNotToContain(panelStyles, '.media-library-item-thumb')
        expectSourceNotToContain(panelStyles, '.media-library-item-info')
        expectSourceToContain(panelSource, 'private buildAssetInspector(asset: Asset): HTMLElement')
        expectSourceToContain(panelSource, 'private async mountAssetDocuments')
        expectSourceToContain(panelSource, "role: 'provenance'")
    })

    it('formats media names and byte sizes consistently', () => {
        expect(stripMediaFileExtension('reference.image.png')).toBe('reference.image')
        expect(stripMediaFileExtension('untitled')).toBe('untitled')
        expect(formatMediaFileSize(512)).toBe('1 KB')
        expect(formatMediaFileSize(1024 * 1024)).toBe('1.0 MB')
    })

    it('hosts the embedded library so it fills the right side panel body', () => {
        expectSourceToContain(panelStyles, '.workspace-right-panel-media-host .media-library-panel')
        expectSourceToContain(panelStyles, '@container media-library (min-width: 680px)')
        expectSourceToContain(panelStyles, '.media-library-panel-images .media-library-body')
        expectSourceToContain(panelStyles, '.media-library-panel-images .media-library-inspector')
    })

    it('drives the right side panel surface from the four top-level modes', () => {
        expectSourceToContain(canvasSource, 'new WorkspaceRightPanel({')
        expectSourceToContain(canvasSource, 'mountContent: this.outputDetails.mountContent,')
        expectSourceToContain(canvasSource, "mode === 'capabilities'")
        expectSourceToContain(canvasSource, "mode === 'artifacts'")
        expectSourceToContain(canvasSource, "mode === 'media'")
        expectSourceToContain(canvasSource, 'private openRightSidePanelToMode =')
        expectSourceToContain(canvasSource, 'this.ports.libraries.mount(host, mode)')
        expectSourceToContain(canvasSource, 'libraries: this.libraries,')
    })

    it('supplies the package chrome with the Media Library toggle', () => {
        expectSourceToContain(workspaceCanvasViewSource, 'new WorkspaceCanvasChrome(settings, {')
        expectSourceToContain(workspaceCanvasViewSource, 'toggleMediaLibrary: () => this.renderer?.toggleMediaLibrary()')
    })

    it('inserts catalog Assets through the existing centered insertion path', () => {
        expectSourceToContain(canvasSource, 'onInsertAsset: async (item: AssetMeta) => {')
        expectSourceToContain(canvasSource, 'insertNode: node => this.insertNodeAtViewportCenterInternal(node, {}, false)')
        expectSourceToContain(canvasSource, 'await this.ports.attachAsset({ assetId: item.assetId, nodeId, canvasState: nextState })')
        expectSourceToContain(workspaceCanvasViewSource, 'importUrl: url => this.actions.importUrl(url)')
    })

    it('supplies URL import and captured workspace ports to the package workflow', () => {
        expectSourceToContain(workspaceCanvasViewSource, 'importUrl: request => importCanvasAssetUrl(auth, request),')
        expectSourceToContain(workspaceCanvasViewSource, 'readScope: () =>')
        expectSourceToContain(workspaceCanvasViewSource, 'this.isLoaded() && this.renderer && this.canvasState')
        expectSourceToContain(workspaceCanvasViewSource, 'importUrl: url => this.actions.importUrl(url)')
    })
})
