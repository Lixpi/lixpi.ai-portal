import {
    type CanvasNode,
    type CanvasState,
    type WorkspaceEdge,
} from '@lixpi/constants'
import { createDocumentHtml } from '@lixpi/ui-primitives/dom'
import {
    buildNodesById,
    computeWorldPosition,
    getAdaptiveBoundedZoomScalingOptions,
    scaleCanvasChromeWorldSizeForZoom,
    type CanvasEngineRect,
    type CanvasViewport,
} from '@lixpi/canvas-engine/shared'
import {
    RectangleOverlay,
    type CanvasDrawingScope,
} from '@lixpi/canvas-engine/frontend/rendering'
import {
    CanvasController,
    Lifetime,
    type CanvasConnectionControls,
} from '@lixpi/canvas-engine/frontend/runtime'
import {
    type ConnectorMarker,
    type ConnectionSettings,
} from '@lixpi/canvas-engine/frontend/connectors'
import {
    TravelingOutline,
    getRoundedOutlinePerimeter,
    type TravelingOutlineDatum,
    type TravelingOutlineDirection,
} from '@lixpi/canvas-components/effects/outline'
import {
    ClosedGlassStripMaterial,
    DomGlassBorder,
    type DomGlassTarget,
    type GlassBorderStyle,
    type GlassMaterialStyle,
} from '@lixpi/canvas-components/effects/glass'
import {
    getWorkspaceLoadingPresentation,
    type WorkspaceLoadingSettings,
} from '../loading/workspace-loading-outline.ts'
import {
    WorkspaceMediaSources,
    type WorkspaceMediaSourcePorts,
} from './workspace-media-sources.ts'
import {
    WorkspaceMediaNodes,
    isWorkspaceMediaNode,
    type WorkspaceMediaNodesOptions,
} from './workspace-media-nodes.ts'
import {
    WorkspaceNodeRegistry,
    type WorkspaceNodeRegistryOptions,
    type WorkspaceRegisteredNodeData,
} from '../nodes/workspace-node-registry.ts'
import { WorkspaceConnectionProjection } from '../connectors/workspace-connection-projection.ts'
import {
    createWorkspaceConnectionPolicy,
    workspaceConnectorMarkerBodyLengthFraction,
} from '../connectors/workspace-connection-manager.ts'

export type SelectionColors = {
    marqueeStroke: string
    marqueeFill: string
    groupOverlayStroke: string
    groupOverlayFill: string
}
export type GeneratingMediaOutlineOptions = {
    direction?: TravelingOutlineDirection
    shape?: 'node' | 'preFrameCircle'
    sourceRendition?: 'original'
}
export type GeneratingMediaOutlineTarget = TravelingOutlineDirection | GeneratingMediaOutlineOptions | undefined
export type GeneratingMediaOutlineTargets = Set<string> | Map<string, GeneratingMediaOutlineTarget>
export type WorkspaceRendererHealth = 'initializing' | 'ready' | 'failed' | 'destroyed'

export type WorkspaceMediaLayerOptions = Pick<WorkspaceMediaNodesOptions, 'onImageIntrinsicSize' | 'onVideoIntrinsicSize' | 'onPlaybackReady'> & {
    paneEl: HTMLElement
    viewportEl: HTMLElement
    nodes: Pick<WorkspaceNodeRegistryOptions, 'geometry' | 'mountDom'> & {
        visible: (state: CanvasState) => readonly CanvasNode[]
    }
    getWorkspaceId: () => string
    sources: WorkspaceMediaSourcePorts
    selectionColors: SelectionColors
    marker: ConnectorMarker
    onEdgesChange: (edges: WorkspaceEdge[]) => void
    onEdgeSelectionChange?: (edgeId: string | null) => void
    settings: WorkspaceLoadingSettings & {
        connector: ConnectionSettings
        canvasChrome: { glassBorder: Omit<GlassBorderStyle, 'edgeFeatherFraction'> & {
            glassMaterial: GlassMaterialStyle
            materialColors: string[]
            materialTailAlpha: number
        } }
    }
    onHealthChange?: (health: WorkspaceRendererHealth) => void
    onError: (error: unknown) => void
}

export class WorkspaceMediaLayer {
    private readonly lifetime = new Lifetime()
    readonly playback: WorkspaceMediaNodes
    private readonly host: HTMLElement
    private readonly nodes: WorkspaceNodeRegistry
    readonly canvas: CanvasController
    readonly connections: CanvasConnectionControls
    private readonly connectionProjection: WorkspaceConnectionProjection<WorkspaceRegisteredNodeData>
    private readonly drawing: CanvasDrawingScope
    private readonly sources: WorkspaceMediaSources
    private readonly outlines: TravelingOutline
    private readonly glass: DomGlassBorder
    private readonly marquee: RectangleOverlay
    private readonly selection: RectangleOverlay
    private readonly resizeObserver: ResizeObserver
    private health: WorkspaceRendererHealth = 'initializing'
    private viewport: CanvasViewport = {
        x: 0,
        y: 0,
        zoom: 1,
    }
    private state: CanvasState | null = null
    private workspaceId = ''
    private revision = 0
    private targets = new Map<string, GeneratingMediaOutlineOptions>()
    private readonly liveBounds = new Map<string, CanvasEngineRect>()
    private destroyed = false

    constructor(private readonly options: WorkspaceMediaLayerOptions) {
        try {
            const html = createDocumentHtml(options.paneEl.ownerDocument)
            const hostStyle = {
                position: 'absolute',
                inset: '0',
                pointerEvents: 'none',
                zIndex: '2',
            }
            this.host = html`
                <div
                    className="workspace-canvas-media-layer"
                    style=${hostStyle}
                ></div>
            ` as HTMLElement
            this.lifetime.own(() => this.host.remove())
            options.paneEl.insertBefore(this.host, options.viewportEl)
            this.sources = new WorkspaceMediaSources(options.sources)
            this.lifetime.own(() => this.sources.clear())
            this.playback = new WorkspaceMediaNodes({
                ...options,
                sources: this.sources,
                radius: options.settings.mediaNode.styles.borderRadius,
            })
            this.lifetime.own(() => this.playback.clear())
            this.nodes = new WorkspaceNodeRegistry({
                ...options.nodes,
                media: this.playback,
            })
            this.connectionProjection = new WorkspaceConnectionProjection<WorkspaceRegisteredNodeData>({
                settings: options.settings.connector,
                connectorBounds: node => options.nodes.geometry(node.data.node.type).measure(node).connectorBounds,
            })
            this.lifetime.own(() => this.connectionProjection.clear())
            this.canvas = new CanvasController({
                root: options.paneEl,
                renderRoot: this.host,
                overlayRoot: options.viewportEl,
                registry: this.nodes.registry,
                scene: {
                    sceneKey: '',
                    revision: '0',
                    nodes: [],
                    edges: [],
                },
                viewport: this.viewport,
                interaction: false,
                connectors: false,
                mediaResolver: this.sources,
                renderer: { beforeRender: () => this.glass?.refresh() },
                visibilityMargin: 1200,
                prefetchBatchSize: 20,
                onError: options.onError,
                onIntent: () => {},
            })
            this.lifetime.own(() => this.canvas.destroy())
            this.canvas.scene.worldElement.classList.add('workspace-viewport')
            this.connections = this.canvas.installConnections({
                settings: options.settings.connector,
                renderer: {
                    marker: options.marker,
                    zoomScaling: options.settings.connector.scaling.zoomScaling,
                },
                markerBodyLengthFraction: workspaceConnectorMarkerBodyLengthFraction,
                policy: createWorkspaceConnectionPolicy(),
                onSelectionChange: options.onEdgeSelectionChange,
                onEdgesChange: edges => {
                    if (this.state)
                        options.onEdgesChange(
                            this.connectionProjection.applyChanges(this.state.edges, edges),
                        )
                },
            })
            this.drawing = this.canvas.renderer.createScope()
            this.lifetime.own(() => this.drawing.destroy())
            const outline = getWorkspaceLoadingPresentation(options.settings).outline
            this.outlines = new TravelingOutline({
                ...outline,
                surface: this.drawing,
                getStrokeScale: () => this.strokeScale(),
            })
            const glass = options.settings.canvasChrome.glassBorder
            this.glass = new DomGlassBorder({
                root: options.paneEl,
                surface: this.drawing,
                style: {
                    ...glass,
                    edgeFeatherFraction: glass.glassMaterial.edgeFeatherFraction,
                },
                texture: new ClosedGlassStripMaterial(
                    glass.materialColors,
                    glass.materialTailAlpha,
                    glass.glassMaterial,
                ).bake(),
            })
            this.marquee = new RectangleOverlay({
                surface: this.drawing,
                stroke: options.selectionColors.marqueeStroke,
                fill: options.selectionColors.marqueeFill,
                radius: 8,
            })
            this.selection = new RectangleOverlay({
                surface: this.drawing,
                stroke: options.selectionColors.groupOverlayStroke,
                fill: options.selectionColors.groupOverlayFill,
                radius: 18,
            })
            this.resizeObserver = new ResizeObserver(() => this.resize())
            this.lifetime.own(() => this.resizeObserver.disconnect())
            this.resizeObserver.observe(options.paneEl)
            this.resize()
            void this.initialize()
        } catch (error) {
            try {
                this.lifetime.destroy()
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Workspace media initialization failed')
            }

            throw error
        }
    }

    private async initialize(): Promise<void> {
        const ready = await this.canvas.ready

        if (this.destroyed)
            return

        this.health = ready ? 'ready' : 'failed'
        this.options.onHealthChange?.(this.health)

        if (ready)
            this.scheduleRender()
    }

    sync(state: CanvasState | null): void {
        if (this.destroyed)
            return

        const workspaceId = this.options.getWorkspaceId()

        if (
            workspaceId !== this.workspaceId
            || !state
        ) {
            this.canvas.setScene({
                sceneKey: workspaceId,
                revision: String(++this.revision),
                nodes: [],
                edges: [],
            })
            this.playback.clear()
            this.sources.clear()
            this.targets.clear()
            this.connectionProjection.clear()
            this.marquee.setBounds(null)
            this.selection.setBounds(null)
        }

        this.workspaceId = workspaceId
        this.state = state
        this.liveBounds.clear()
        this.publishScene()
    }

    private publishScene(): void {
        if (this.destroyed)
            return

        const byId = buildNodesById(this.state?.nodes ?? [])
        const visibleNodes = this.state ? this.options.nodes.visible(this.state) : []
        const visibleIds = new Set(
            visibleNodes.map(node => node.nodeId),
        )
        this.playback.retain(
            new Set(
                visibleNodes.filter(isWorkspaceMediaNode).map(node => node.nodeId),
            ),
        )
        const nodes = visibleNodes.map(node => {
            const target = this.targets.get(node.nodeId)
            const projected = this.nodes.project(
                node,
                target?.shape === 'preFrameCircle' || (node.type === 'image' && Boolean(node.generatedBy) && !node.assetId),
                target?.sourceRendition === 'original',
            )
            const bounds = this.liveBounds.get(node.nodeId)
            const parent = node.parentId
                && visibleIds.has(node.parentId)
                ? byId.get(node.parentId)
                : undefined
            const world = bounds ?? computeWorldPosition(
                node,
                byId,
                id => this.liveBounds.get(id),
            )
            const origin = parent ? computeWorldPosition(
                parent,
                byId,
                id => this.liveBounds.get(id),
            ) : {
                x: 0,
                y: 0,
            }

            return {
                ...projected,
                parentId: parent?.nodeId,
                position: {
                    x: world.x - origin.x,
                    y: world.y - origin.y,
                },
                dimensions: bounds ? {
                    width: bounds.width,
                    height: bounds.height,
                } : node.dimensions,
            }
        })
        const edges = (this.state?.edges ?? []).filter(edge => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId))
        const projected = this.connectionProjection.project(nodes, edges)
        this.canvas.setScene({
            sceneKey: this.workspaceId,
            revision: String(++this.revision),
            ...projected,
        })
        this.syncOutlines()
    }

    retryAssetTextures(assetIds: ReadonlySet<string>): void {
        if (
            this.destroyed
            || !assetIds.size
        )
            return

        this.sources.retry(assetIds)
        this.publishScene()
    }

    refreshAssets(assetIds: ReadonlySet<string>): void {
        if (
            !this.destroyed
            && assetIds.size
        )
            this.publishScene()
    }

    setTransientImageSource(
        nodeId: string,
        url: string | null,
    ): void {
        if (this.destroyed)
            return

        this.playback.setTransient(nodeId, url)
        this.publishScene()
    }

    setGeneratingImageNodes(targets: GeneratingMediaOutlineTargets): void {
        if (this.destroyed)
            return

        this.targets = targets instanceof Map
            ? new Map(
                Array.from(targets, ([id, target]) => [id, typeof target === 'string' ? { direction: target } : target ?? {}]),
            )
            : new Map(
                Array.from(targets, id => [id, {}]),
            )
        this.publishScene()
    }

    setViewport(viewport: CanvasViewport): void {
        if (this.destroyed)
            return

        if (
            !Object.values(viewport).every(Number.isFinite)
            || viewport.zoom <= 0
        )
            throw new RangeError('Viewport must be finite with positive zoom')

        this.viewport = { ...viewport }
        this.resize()
        this.marquee.setZoom(viewport.zoom)
        this.selection.setZoom(viewport.zoom)
        this.publishScene()
    }

    private resize(): void {
        if (this.destroyed)
            return

        const rect = this.options.paneEl.getBoundingClientRect()
        this.canvas.setViewport(this.viewport)
        this.canvas.resize({
            width: Math.max(1, rect.width),
            height: Math.max(1, rect.height),
        })
    }

    setNodeLiveTransform(
        nodeId: string,
        position: {
            x: number
            y: number
        },
        dimensions: {
            width: number
            height: number
        },
    ): void {
        if (this.destroyed)
            return

        const bounds = {
            ...position,
            ...dimensions,
        }
        this.liveBounds.set(nodeId, bounds)
        this.canvas.scene.setLiveBounds(nodeId, bounds)
        this.publishScene()
    }

    private strokeScale(): number {
        return scaleCanvasChromeWorldSizeForZoom(
            1,
            this.viewport.zoom,
            getAdaptiveBoundedZoomScalingOptions(this.options.settings.mediaNode.inProgressOutlineAnimation.zoomScaling),
        )
    }

    private syncOutlines(): void {
        const animation = this.options.settings.mediaNode.inProgressOutlineAnimation
        const byId = buildNodesById(this.state?.nodes ?? [])
        const datums: TravelingOutlineDatum[] = []

        for (const [id, target] of this.targets) {
            const node = byId.get(id)

            if (!node)
                continue

            const bounds = this.liveBounds.get(id) ?? {
                ...computeWorldPosition(node, byId),
                ...node.dimensions,
            }
            const radius = Math.max(
                0,
                Math.min(
                    node.type === 'image'
                        || node.type === 'video'
                        ? this.options.settings.mediaNode.styles.borderRadius
                        : animation.radius,
                    bounds.width / 2,
                    bounds.height / 2,
                ),
            )
            let datum: TravelingOutlineDatum = {
                id,
                ...bounds,
                radius,
                visible: true,
                direction: target.direction,
            }

            if (target.shape === 'preFrameCircle') {
                const configured = animation.preFrameCircleScale
                const scale = Number.isFinite(configured)
                    && configured > 0
                    ? Math.min(1, configured)
                    : 1 / 3
                const size = Math.max(1, Math.min(bounds.width, bounds.height) * scale)
                const outset = (animation.gap + animation.snakeWidth / 2) * this.strokeScale()
                const nodePerimeter = getRoundedOutlinePerimeter(
                    bounds.width + outset * 2,
                    bounds.height + outset * 2,
                    radius + outset,
                )
                const circlePerimeter = getRoundedOutlinePerimeter(
                    size + outset * 2,
                    size + outset * 2,
                    size / 2 + outset,
                )
                datum = {
                    ...datum,
                    x: bounds.x + (bounds.width - size) / 2,
                    y: bounds.y + (bounds.height - size) / 2,
                    width: size,
                    height: size,
                    radius: size / 2,
                }

                if (
                    nodePerimeter > 0
                    && circlePerimeter > 0
                ) {
                    datum.durationMs = (animation.animationDurationMs * circlePerimeter) / nodePerimeter
                    datum.snakeLengthFraction = Math.min(0.98, (animation.snakeLengthFraction * nodePerimeter) / circlePerimeter)
                }
            }

            datums.push(datum)
        }

        this.outlines.sync(datums)
    }

    setSelectedImageNodes(ids: ReadonlySet<string>): void {
        this.canvas.setSelected(ids, this.canvas.selection.fromMarquee)
    }
    setMarqueeRect(bounds: CanvasEngineRect | null): void {
        this.marquee.setBounds(bounds)
    }
    setSelectionOverlayBounds(
        bounds: CanvasEngineRect | null,
        options: { fill?: boolean } = {},
    ): void {
        this.selection.setBounds(bounds, options.fill !== false)
    }
    setGlassTargets(targets: readonly DomGlassTarget[]): void {
        this.glass.setTargets(targets)
    }
    renderNow(): void {
        this.canvas.renderer.renderNow()
    }
    scheduleRender(): void {
        this.canvas.renderer.invalidate()
    }
    getHealth(): WorkspaceRendererHealth {
        return this.health
    }
    get worldElement(): HTMLElement {
        return this.canvas.scene.worldElement
    }
    getNodeBounds(nodeId: string): CanvasEngineRect | undefined {
        return this.canvas.scene.getWorldBounds(nodeId)
    }

    destroy(): void {
        if (this.destroyed)
            return

        this.destroyed = true
        this.health = 'destroyed'

        try {
            this.lifetime.destroy()
        } catch (error) {
            this.options.onError(error)
        }

        this.options.onHealthChange?.(this.health)
    }
}

export const createWorkspaceMediaLayer = (options: WorkspaceMediaLayerOptions): WorkspaceMediaLayer => new WorkspaceMediaLayer(options)
