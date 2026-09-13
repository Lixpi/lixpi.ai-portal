import {
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import {
    ACTION_TIMELINE_FRONTEND_STYLES,
    actionTimelineFrontendDefinition,
} from '@lixpi/capability-system/frontend'
import { buildActionTimelineDocument } from '@lixpi/capability-system'

import {
    createInstalledCapabilityControls,
    ensureCapabilityStyles,
} from './installed-capabilities.ts'

const extractCssRule = (selector: string): string => {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = ACTION_TIMELINE_FRONTEND_STYLES.match(new RegExp(`${escapedSelector} \\{([^}]*)\\}`, 's'))

    if (!match?.[1])
        throw new Error(`Missing CSS rule: ${selector}`)

    return match[1]
}

describe('installed Action Timeline frontend', () => {
    it('registers a complete package-owned Artifact frontend definition', () => {
        expect(actionTimelineFrontendDefinition).toMatchObject({
            artifactTypeId: 'action-timeline',
            iconId: 'ordered-list',
            createCanvasNodeView: expect.any(Function),
            createGeneratedOutputInfoView: expect.any(Function),
            createPromptReferenceView: expect.any(Function),
            createLibraryItemView: expect.any(Function),
        })
        expect(actionTimelineFrontendDefinition.createPromptControls).toBeUndefined()
    })

    it('does not mount a parameter form for the Action Timeline module chip', () => {
        const container = document.createElement('div')
        const setCapabilityInputs = vi.fn()
        const setValidity = vi.fn()
        const controls = createInstalledCapabilityControls({
            container,
            getModuleIds: () => ['action-timeline'],
            getPromptText: () => 'Build a 15-second action timeline with 3-second beats.',
            getCapabilityInputs: () => ({}),
            setCapabilityInputs,
            setValidity,
        })
        controls.update()

        expect(container.childElementCount).toBe(0)
        expect(setCapabilityInputs).not.toHaveBeenCalled()
        expect(setValidity).not.toHaveBeenCalled()
        controls.destroy()
    })

    it('installs the Action Timeline stylesheet as executable CSS exactly once per document', () => {
        const capabilityDocument = document.implementation.createHTMLDocument('Capability styles')

        ensureCapabilityStyles(capabilityDocument)
        ensureCapabilityStyles(capabilityDocument)

        const styles = capabilityDocument.head.querySelectorAll<HTMLStyleElement>(
            'style[data-capability-styles="action-timeline"]',
        )
        expect(styles).toHaveLength(1)
        expect(styles[0]?.textContent).toBe(ACTION_TIMELINE_FRONTEND_STYLES)
        expect(styles[0]?.sheet?.cssRules.length).toBeGreaterThan(0)
        expect(styles[0]?.getAttribute('textContent')).toBeNull()
    })

    it('uses one branch-lineage surface with compact, borderless timeline content', () => {
        expect(ACTION_TIMELINE_FRONTEND_STYLES).toContain(
            '--action-timeline-surface: var(--workspace-branch-origin-background-color, #5d656d);',
        )
        expect(extractCssRule('.action-timeline-time')).not.toContain('border:')
        expect(extractCssRule('.action-timeline-time')).not.toContain('background:')
        expect(extractCssRule('.action-timeline-time')).toContain('color: var(--action-timeline-timecode);')
        expect(extractCssRule('.action-timeline-editor .action-timeline-segment')).toContain('background: transparent;')
        expect(extractCssRule('.action-timeline-editor .action-timeline-segment')).toContain('border-radius: 0;')
        expect(extractCssRule('.action-timeline-editor .action-timeline-segment')).toContain('box-shadow: none;')
        expect(extractCssRule('.action-timeline-editor')).toContain('position: relative;')
        expect(extractCssRule('.action-timeline-editor')).toContain('z-index: 2;')
        expect(extractCssRule('.action-timeline-reference')).toContain('background: transparent;')
        expect(extractCssRule('.action-timeline-reference')).toContain('border: 0;')
        expect(extractCssRule('.action-timeline-reference')).toContain('font: inherit;')
        expect(extractCssRule('.action-timeline-reference')).toContain('text-decoration: none;')
        expect(ACTION_TIMELINE_FRONTEND_STYLES).not.toContain('text-decoration: underline;')
        expect(extractCssRule('.action-timeline-editor .prompt-reference-chip-icon')).toContain('width: 14px;')
        expect(extractCssRule('.action-timeline-editor .prompt-reference-chip-icon')).toContain('height: 14px;')
        expect(ACTION_TIMELINE_FRONTEND_STYLES).toContain('--prompt-reference-color: #d7e6ff;')
        expect(ACTION_TIMELINE_FRONTEND_STYLES).toContain('.action-timeline-editor .prompt-reference-chip,')
    })

    it('renders generated-output metrics as flat typographic pairs', () => {
        expect(extractCssRule('.action-timeline-info')).toContain('display: flex;')
        expect(extractCssRule('.action-timeline-info-item')).toContain('padding: 0;')
        expect(extractCssRule('.action-timeline-info-item')).toContain('border: 0;')
        expect(extractCssRule('.action-timeline-info-item')).toContain('border-radius: 0;')
        expect(extractCssRule('.action-timeline-info-item')).toContain('background: transparent;')
        expect(extractCssRule('.action-timeline-info-item + .action-timeline-info-item::before')).toContain(
            "content: '·';",
        )
    })

    it('delegates Timeline thumbnails and inline references to one host preview factory', () => {
        const container = document.createElement('div')
        const createAssetReferenceView = vi.fn(({
            assetId,
            variant,
        }) => {
            const dom = document.createElement('span')
            dom.textContent = `${variant}:${assetId}`

            return {
                dom,
                destroy: vi.fn(),
            }
        })
        const timeline = buildActionTimelineDocument(
            {
                durationMs: 1000,
                precisionMs: 1000,
            },
            [{
                slotIndex: 0,
                runs: [{ text: 'Board ' }, { assetId: 'train-asset' }],
            }],
            new Map([['train-asset', { mediaKind: 'video' as const }]]),
        )
        const view = actionTimelineFrontendDefinition.createCanvasNodeView({
            container,
            node: {
                type: 'capabilityArtifact',
                nodeId: 'timeline-node',
                artifactTypeId: 'action-timeline',
                assetId: 'timeline-asset',
                position: {
                    x: 0,
                    y: 0,
                },
                dimensions: {
                    width: 520,
                    height: 360,
                },
            },
            document: timeline,
            createAssetReferenceView,
            onHeightChange: vi.fn(),
        })

        expect(createAssetReferenceView).toHaveBeenCalledWith({
            assetId: 'train-asset',
            variant: 'thumbnail',
        })
        expect(createAssetReferenceView).toHaveBeenCalledWith({
            assetId: 'train-asset',
            displayName: 'train-asset',
            variant: 'inline',
        })
        expect(container.querySelector('.action-timeline-thumbnails')?.textContent).toBe('thumbnail:train-asset')
        expect(container.querySelector('.action-timeline-content')?.textContent).toBe('Board inline:train-asset')
        view.destroy()
    })
})
