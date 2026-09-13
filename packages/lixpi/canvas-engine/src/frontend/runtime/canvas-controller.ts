import {
    createDocumentHtml,
    isEditableTarget,
} from '@lixpi/ui-primitives/dom'
import {
    buildNodesById,
    computeDragPlan,
    computeGeometryChanges,
    getIntersectingNodeIds,
    rectangleContainsPoint,
    unionRectangles,
    validateScene,
    type CanvasDiagnostic,
    type CanvasEnginePoint,
    type CanvasEngineRect,
    type CanvasEngineSize,
    type CanvasIntent,
    type CanvasViewport,
    type CollisionOptions,
    type Dispose,
    type EngineNode,
    type ResizeHandle,
    type SceneSnapshot,
} from '../../shared/index.ts'
import {
    CanvasRenderer,
    type CanvasRendererOptions,
} from '../rendering/index.ts'
import { ConnectionManager } from '../connectors/connection-manager.ts'
import {
    ConnectorRenderer,
    type ConnectorRendererOptions,
} from '../connectors/connector-renderer.ts'
import {
    type ConnectionEdge,
    type ConnectionPolicy,
    type ConnectionSettings,
} from '../connectors/connection-types.ts'
import {
    ViewportController,
    type ViewportControllerOptions,
} from '../viewport/viewport-controller.ts'
import { CanvasScene } from './canvas-scene.ts'
import { GeometryOverrides } from './geometry-overrides.ts'
import {
    GestureController,
    type CanvasGesture,
    type GestureCancelReason,
} from './gesture-controller.ts'
import {
    CanvasKeyboardController,
    type CanvasKeyboardOptions,
} from './keyboard-controller.ts'
import { Lifetime } from './lifetime.ts'
import {
    MarqueeController,
    type MarqueeControllerOptions,
} from './marquee-controller.ts'
import { NodeHandles } from './node-handles.ts'
import {
    NodeTransformController,
    type NodeTransformOptions,
    type NodeResizeOptions,
} from './node-transform-controller.ts'
import { CanvasSelection } from './selection.ts'
import {
    SelectionOverlay,
    type SelectionOverlayOptions,
} from './selection-overlay.ts'
import {
    type CanvasDrawingContext,
    type NodeRegistry,
} from './node-registry.ts'

export type CanvasExtension = {
    id: string
    mount: (context: CanvasDrawingContext & { overlayRoot: HTMLElement }) => Dispose
}
export type CanvasInteractionOptions = {
    dragThreshold?: number
    marqueeThreshold?: number
    handleSize?: number
    marquee?: SelectionOverlayOptions['marquee']
    viewport?: Omit<ViewportControllerOptions, 'root' | 'viewport' | 'onTransformChange'>
    isInteractiveTarget?: (element: Element) => boolean
    onSelectionChange?: (
        nodeIds: ReadonlySet<string>,
        fromMarquee: boolean,
    ) => void
}
export type CanvasConnectionControls = Pick<ConnectionManager<EngineNode>, 'flowId' | 'cancelTransientConnection' | 'startConnectionFromMenu' | 'onHandlePointerDown' | 'selectEdge' | 'deleteSelectedEdge' | 'deselect' | 'getEdgeMidpointRect' | 'checkProximity' | 'commitProximityConnection' | 'recomputeConnectorGeometry' | 'render'>
export type CanvasConnectionOptions = {
    settings: ConnectionSettings
    renderer?: Omit<ConnectorRendererOptions, 'surface'>
    markerBodyLengthFraction?: number
    policy?: Partial<ConnectionPolicy<EngineNode>>
    onSelectionChange?: (edgeId: string | null) => void
    onEdgesChange?: (edges: readonly ConnectionEdge[]) => void
}
export type CanvasOptions = {
    root: HTMLElement
    renderRoot?: HTMLElement
    scene: SceneSnapshot
    viewport: CanvasViewport
    registry: NodeRegistry
    overlayRoot?: HTMLElement
    extensions?: readonly CanvasExtension[]
    interaction?: CanvasInteractionOptions | false
    connectors?: CanvasConnectionOptions | false
    collisions?: CollisionOptions
    renderer?: Omit<CanvasRendererOptions, 'root' | 'onError' | 'mediaResolver'>
    mediaResolver?: CanvasRendererOptions['mediaResolver']
    visibilityMargin?: number
    prefetchBatchSize?: number
    onIntent: (intent: CanvasIntent) => void
    onError: (
        error: unknown,
        nodeId?: string,
    ) => void
    onDiagnostic?: (diagnostic: CanvasDiagnostic) => void
}

// A canvas owns its rendering, scene, input, scopes and extensions. The host owns
// authoritative state and applies intents through setScene/setViewport.
export class CanvasController {
    readonly renderer: CanvasRenderer
    readonly scene: CanvasScene
    readonly geometry = new GeometryOverrides()
    readonly selection = new CanvasSelection()
    readonly ready: Promise<boolean>
    private readonly lifetime = new Lifetime()
    private readonly gestures = new GestureController()
    private readonly extensions = new Map<string, Dispose>()
    private readonly handles = new Map<string, NodeHandles>()
    private readonly interaction: CanvasInteractionOptions | false
    private readonly pane: HTMLDivElement
    private readonly transforms: NodeTransformController
    private viewport: ViewportController | null = null
    private connections: ConnectionManager<EngineNode> | null = null
    private selectionOverlay: SelectionOverlay | null = null
    private marquee: MarqueeController | null = null
    private keyboard: CanvasKeyboardController | null = null
    private selectedEdge: string | null = null
    private transforming = new Set<string>()
    private destroyed = false

    constructor(private readonly options: CanvasOptions) {
        validateScene(options.scene)
        this.interaction = options.interaction === false ? false : {
            ...options.interaction,
            marquee: options.interaction?.marquee ? { ...options.interaction.marquee } : undefined,
        }
        const html = createDocumentHtml(options.root.ownerDocument)
        this.pane = html`<div className="canvas-engine-pane"></div>` as HTMLDivElement

        try {
            const renderRoot = options.renderRoot ?? options.root
            renderRoot.appendChild(this.pane)
            this.lifetime.own(() => this.pane.remove())
            this.lifetime.own(() => this.geometry.destroy())
            this.renderer = new CanvasRenderer({
                ...options.renderer,
                root: this.pane,
                mediaResolver: options.mediaResolver,
                onError: options.onError,
            })
            this.lifetime.own(() => this.renderer.destroy())
            this.scene = new CanvasScene({
                ...options,
                renderer: this.renderer,
                root: options.overlayRoot ?? this.pane,
                geometry: this.geometry,
            })
            this.lifetime.own(() => this.scene.destroy())
            this.transforms = new NodeTransformController({
                root: options.root,
                gestures: this.gestures,
                overrides: this.geometry,
                getViewport: () => this.scene.viewport,
            })
            this.lifetime.own(() => this.gestures.destroy())
            this.lifetime.own(() => {
                for (const handle of this.handles.values())
                    handle.destroy()

                this.handles.clear()
            })

            if (this.interaction)
                this.installInteraction(this.interaction)

            if (options.connectors)
                this.installConnections(options.connectors)

            const resize = new ResizeObserver(() => this.resize())
            this.lifetime.own(() => resize.disconnect())
            resize.observe(options.root)
            this.setViewport(options.viewport)
            this.setScene(options.scene)

            for (const extension of options.extensions ?? [])
                this.installExtension(extension)

            this.ready = this.initialize()
        } catch (error) {
            try {
                this.destroy()
            } catch (cleanup) {
                options.onError(cleanup)
            }

            throw error
        }
    }

    private async initialize(): Promise<boolean> {
        const ready = await this.renderer.ready

        if (
            !ready
            && !this.destroyed
        ) {
            try {
                this.destroy()
            } catch (error) {
                this.options.onError(error)
            }
        }

        return ready && !this.destroyed
    }

    private installInteraction(options: CanvasInteractionOptions): void {
        this.installViewport({
            ...options.viewport,
            onTransformChange: ([x, y, zoom]) => {
                this.scene.setViewport({
                    x,
                    y,
                    zoom,
                })
                this.refreshPresentation()
                this.emit({
                    kind: 'viewport',
                    sceneKey: this.scene.scene.sceneKey,
                    viewport: {
                        x,
                        y,
                        zoom,
                    },
                })
            },
        })
        this.installSelectionOverlay({
            marquee: options.marquee ?? {
                borderColor: 'currentColor',
                backgroundColor: 'transparent',
            },
            onGroupPointerDown: event => {
                const first = this.selection.nodeIds.values().next().value

                if (first)
                    this.startDrag(event, first)
            },
        })
        this.installMarquee({
            threshold: options.marqueeThreshold,
            lock: () => this.viewport!.lock({ selection: true }),
            onStart: () => {
                this.connections?.selectEdge(null)
                this.setSelected([])
            },
            onChange: bounds => {
                this.selectionOverlay!.setMarquee(bounds)
                const selected = getIntersectingNodeIds(
                    this.scene.scene.nodes,
                    bounds,
                    node => this.scene.getNodeGeometry(node.nodeId)!.selectionBounds,
                )
                this.setSelected(selected, true)
            },
            onEnd: moved => {
                this.selectionOverlay!.setMarquee(null)

                if (!moved)
                    this.setSelected([])

                this.refreshSelection()
            },
            onCancel: () => {
                this.selectionOverlay!.setMarquee(null)
                this.refreshSelection()
            },
        })
        this.installKeyboard({
            onEscape: () => {
                this.cancelInteraction('escape')
                this.connections?.selectEdge(null)
                this.setSelected([])
            },
            onDelete: () => {
                const nodeIds = Array.from(this.selection.nodeIds)
                const edgeIds = this.selectedEdge ? [this.selectedEdge] : []

                if (
                    !nodeIds.length
                    && !edgeIds.length
                )
                    return false

                this.emit({
                    kind: 'delete',
                    sceneKey: this.scene.scene.sceneKey,
                    nodeIds,
                    edgeIds,
                })

                return true
            },
        })
        this.options.root.addEventListener(
            'mousedown',
            this.pointerDown,
            true,
        )
        this.lifetime.own(
            () => this.options.root.removeEventListener(
                'mousedown',
                this.pointerDown,
                true,
            ),
        )
    }

    installConnections(options: CanvasConnectionOptions): CanvasConnectionControls {
        this.assertAlive()

        if (this.connections)
            throw new Error('Canvas connection input is already installed')

        const lifetime = this.lifetime.child()

        try {
            const surface = this.renderer.createScope()
            lifetime.own(() => surface.destroy())
            const drawing = new ConnectorRenderer({
                ...options.renderer,
                surface,
            })
            lifetime.own(() => drawing.destroy())
            this.connections = new ConnectionManager({
                isCentered: () => true,
                isNodeTarget: target => Boolean(
                    target.closest('[data-canvas-node-id]'),
                ),
                ...options.policy,
                paneEl: this.options.root as HTMLDivElement,
                viewportEl: this.scene.worldElement as HTMLDivElement,
                settings: options.settings,
                markerBodyLengthFraction: options.markerBodyLengthFraction ?? 1,
                getTransform: () => {
                    const {
                        x,
                        y,
                        zoom,
                    } = this.scene.viewport

                    return [x, y, zoom]
                },
                panBy: async delta => {
                    if (!this.viewport)
                        return false

                    const viewport = this.viewport.getViewport()

                    return this.viewport.setViewport({
                        ...viewport,
                        x: viewport.x + delta.x,
                        y: viewport.y + delta.y,
                    })
                },
                onEdgesChange: edges => {
                    try {
                        if (options.onEdgesChange)
                            options.onEdgesChange(edges)
                        else
                            this.connectionChange(edges)
                    } catch (error) {
                        this.options.onError(error)
                    }
                },
                onError: this.options.onError,
                onSelectedEdgeChange: id => {
                    this.selectedEdge = id

                    if (id)
                        this.setSelected([])

                    options.onSelectionChange?.(id)
                },
                onConnectorGeometry: edges => drawing.render(edges, this.scene.viewport),
            })
            const connection = this.connections
            lifetime.own(() => connection.destroy())
            this.connections.syncEdges(
                this.scene.scene.edges.map(
                    edge => ({
                        edgeId: edge.edgeId,
                        sourceNodeId: edge.source.nodeId,
                        sourceHandle: edge.source.portId,
                        targetNodeId: edge.target.nodeId,
                        targetHandle: edge.target.portId,
                        pathType: edge.path,
                        data: edge.data,
                    }),
                ),
            )
            this.refreshPresentation()

            return this.connections
        } catch (error) {
            this.connections = null
            lifetime.destroy()

            throw error
        }
    }

    installViewport(options: Omit<ViewportControllerOptions, 'root' | 'viewport'>): ViewportController {
        this.assertAlive()

        if (this.viewport)
            throw new Error('Canvas viewport input is already installed')

        const viewport = new ViewportController({
            ...options,
            root: this.options.root,
            viewport: this.scene.viewport,
        })
        this.viewport = viewport
        this.lifetime.own(() => viewport.destroy())

        return viewport
    }

    installSelectionOverlay(options: Omit<SelectionOverlayOptions, 'root'>): SelectionOverlay {
        this.assertAlive()

        if (this.selectionOverlay)
            throw new Error('Canvas selection overlay is already installed')

        const overlay = new SelectionOverlay({
            ...options,
            root: this.scene.worldElement,
        })
        this.selectionOverlay = overlay
        this.lifetime.own(() => overlay.destroy())

        return overlay
    }

    installMarquee(options: Omit<MarqueeControllerOptions, 'root' | 'gestures' | 'getWorldPoint'>): MarqueeController {
        this.assertAlive()

        if (this.marquee)
            throw new Error('Canvas marquee input is already installed')

        const marquee = new MarqueeController({
            ...options,
            root: this.options.root,
            gestures: this.gestures,
            getWorldPoint: (x, y) => this.clientToWorld({
                x,
                y,
            }),
        })
        this.marquee = marquee
        this.lifetime.own(() => marquee.destroy())

        return marquee
    }

    installKeyboard(options: Omit<CanvasKeyboardOptions, 'root'>): CanvasKeyboardController {
        this.assertAlive()

        if (this.keyboard)
            throw new Error('Canvas keyboard input is already installed')

        const keyboard = new CanvasKeyboardController({
            ...options,
            root: this.options.root,
        })
        this.keyboard = keyboard
        this.lifetime.own(() => keyboard.destroy())

        return keyboard
    }

    startNodeDrag(options: NodeTransformOptions): CanvasGesture {
        return this.startTransform(options, wrapped => this.transforms.startDrag(wrapped))
    }

    startNodeResize(options: NodeResizeOptions): CanvasGesture {
        return this.startTransform(
            {
                ...options,
                targets: [options.target],
            },
            wrapped => this.transforms.startResize({
                ...options,
                ...wrapped,
            }),
        )
    }

    private startTransform(
        options: NodeTransformOptions,
        start: (options: NodeTransformOptions) => CanvasGesture,
    ): CanvasGesture {
        this.assertAlive()
        this.cancelInteraction('replaced')
        this.transforming = new Set(
            options.targets.map(target => target.nodeId),
        )

        try {
            return start({
                ...options,
                onChange: bounds => {
                    this.refreshPresentation()
                    options.onChange(bounds)
                },
                onEnd: (
                    event,
                    bounds,
                    moved,
                ) => {
                    this.transforming.clear()

                    try {
                        options.onEnd(
                            event,
                            bounds,
                            moved,
                        )
                    } finally {
                        this.refreshPresentation()
                    }
                },
                onCancel: reason => {
                    this.transforming.clear()

                    try {
                        options.onCancel(reason)
                    } finally {
                        this.refreshPresentation()
                    }
                },
            })
        } catch (error) {
            this.transforming.clear()

            throw error
        }
    }

    private assertAlive(): void {
        if (this.destroyed)
            throw new Error('Canvas controller is disposed')
    }

    private connectionChange = (edges: ConnectionEdge[]): void => {
        const snapshot = this.scene.scene
        const incoming = new Map(
            edges.map(edge => [edge.edgeId, edge]),
        )
        const removed = snapshot.edges.filter(edge => !incoming.has(edge.edgeId)).map(edge => edge.edgeId)
        const intents: CanvasIntent[] = removed.length ? [{
            kind: 'delete',
            sceneKey: snapshot.sceneKey,
            nodeIds: [],
            edgeIds: removed,
        }] : []

        for (const edge of edges) {
            if (
                !edge.sourceHandle
                || !edge.targetHandle
            )
                continue

            const previous = snapshot.edges.find(candidate => candidate.edgeId === edge.edgeId)
            const source = {
                nodeId: edge.sourceNodeId,
                portId: edge.sourceHandle,
            }
            const target = {
                nodeId: edge.targetNodeId,
                portId: edge.targetHandle,
            }

            if (!previous)
                intents.push({
                    kind: 'connect',
                    sceneKey: snapshot.sceneKey,
                    source,
                    target,
                })
            else if (
                previous.source.nodeId !== source.nodeId
                || previous.source.portId !== source.portId
                || previous.target.nodeId !== target.nodeId
                || previous.target.portId !== target.portId
            )
                intents.push({
                    kind: 'reconnect',
                    sceneKey: snapshot.sceneKey,
                    edgeId: edge.edgeId,
                    source,
                    target,
                })
        }

        for (const intent of intents)
            this.emit(intent)
    }

    setScene(snapshot: SceneSnapshot): void {
        if (this.destroyed)
            return

        const changedScene = snapshot.sceneKey !== this.scene.scene.sceneKey
        this.scene.setScene(snapshot)

        if (
            changedScene
            || Array.from(this.transforming).some(id => !snapshot.nodes.some(node => node.nodeId === id))
        )
            this.cancelInteraction('scene-change')

        if (changedScene) {
            this.selection.clear()
            this.selectedEdge = null
        } else for (const id of this.selection.nodeIds)
            if (!snapshot.nodes.some(node => node.nodeId === id))
                this.selection.remove(id)

        this.connections?.syncEdges(
            snapshot.edges.map(
                edge => ({
                    edgeId: edge.edgeId,
                    sourceNodeId: edge.source.nodeId,
                    sourceHandle: edge.source.portId,
                    targetNodeId: edge.target.nodeId,
                    targetHandle: edge.target.portId,
                    pathType: edge.path,
                    data: edge.data,
                }),
            ),
        )
        this.refreshPresentation()
    }

    setViewport(viewport: CanvasViewport): void {
        if (this.destroyed)
            return

        this.scene.setViewport(
            viewport,
            this.size(),
        )
        this.viewport?.syncViewport(viewport)
        this.refreshPresentation()
    }

    resize(size = this.size()): void {
        if (this.destroyed)
            return

        this.renderer.resize(size)
        this.scene.setViewport(this.scene.viewport, size)
        this.refreshPresentation()
    }

    private size(): CanvasEngineSize {
        const bounds = this.options.root.getBoundingClientRect()

        return {
            width: Math.max(1, bounds.width),
            height: Math.max(1, bounds.height),
        }
    }

    clientToWorld = (point: CanvasEnginePoint): CanvasEnginePoint => {
        const bounds = this.options.root.getBoundingClientRect()
        const viewport = this.scene.viewport

        return {
            x: (point.x - bounds.left - viewport.x) / viewport.zoom,
            y: (point.y - bounds.top - viewport.y) / viewport.zoom,
        }
    }

    setSelected(
        ids: Iterable<string>,
        fromMarquee = false,
    ): void {
        if (this.destroyed)
            return

        const available = new Set(
            this.scene.scene.nodes.map(node => node.nodeId),
        )
        this.selection.replace(
            Array.from(ids).filter(id => available.has(id)),
            fromMarquee,
        )
        this.refreshSelection()

        if (this.interaction)
            this.interaction.onSelectionChange?.(
                new Set(this.selection.nodeIds),
                this.selection.fromMarquee,
            )
    }

    private refreshSelection(): void {
        if (this.destroyed)
            return

        this.scene.setSelected(this.selection.nodeIds)
        const bounds = Array.from(this.selection.nodeIds, id => this.scene.getNodeGeometry(id)?.selectionBounds).filter(
            (rect): rect is CanvasEngineRect => Boolean(rect),
        )

        if (this.interaction)
            this.selectionOverlay?.setGroup(this.selection.nodeIds.size > 1
                && !this.marquee?.active
                ? unionRectangles(bounds)
                : null)

        this.refreshHandles()
    }

    private refreshPresentation(): void {
        if (this.destroyed)
            return

        this.scene.refreshGeometry()
        this.connections?.syncNodes(
            this.scene.scene.nodes.map(node => {
                const geometry = this.scene.getNodeGeometry(node.nodeId)!
                const bounds = geometry.connectorBounds

                return {
                    ...node,
                    parentId: undefined,
                    position: {
                        x: bounds.x,
                        y: bounds.y,
                    },
                    dimensions: {
                        width: bounds.width,
                        height: bounds.height,
                    },
                    ports: node.ports.map(
                        port =>
                            ({
                                ...port,
                                anchor: {
                                    x: port.anchor.x + geometry.worldBounds.x - bounds.x,
                                    y: port.anchor.y + geometry.worldBounds.y - bounds.y,
                                },
                            }),
                    ),
                }
            }),
        )

        if (this.connections) {
            for (const node of this.scene.scene.nodes) {
                const root = this.scene.getNodeRoot(node.nodeId)

                if (root)
                    this.connections.registerNodeElement(node.nodeId, root)
            }
        }

        this.connections?.render()
        this.refreshSelection()
    }

    private refreshHandles(): void {
        if (!this.interaction)
            return

        const nodes = this.scene.scene.nodes

        for (const [id, handles] of this.handles) {
            if (!nodes.some(node => node.nodeId === id)) {
                handles.destroy()
                this.handles.delete(id)
            }
        }

        for (const node of nodes) {
            let handles = this.handles.get(node.nodeId)

            if (!handles) {
                handles = new NodeHandles({
                    root: this.scene.worldElement,
                    nodeId: node.nodeId,
                    flowId: this.connections?.flowId ?? '',
                    size: this.interaction.handleSize,
                    onConnect: (
                        event,
                        port,
                        element,
                        isTarget,
                    ) => this.connections?.onHandlePointerDown(
                        event,
                        {
                            nodeId: node.nodeId,
                            handleId: port.id,
                            handleDomNode: element,
                            isTarget,
                        },
                    ),
                    onResize: (event, handle) => this.startResize(
                        event,
                        node.nodeId,
                        handle,
                    ),
                })
                this.handles.set(node.nodeId, handles)
            }

            const root = this.scene.getNodeRoot(node.nodeId)

            if (root)
                root.style.pointerEvents = 'auto'

            handles.update(
                this.scene.getNodeGeometry(node.nodeId)!.worldBounds,
                this.connections ? node.ports : [],
                this.selection.has(node.nodeId),
                this.scene.viewport.zoom,
            )
        }
    }

    private pointerDown = (event: MouseEvent): void => {
        if (
            event.button !== 0
            || event.defaultPrevented
            || !this.interaction
        )
            return

        const target = event.target as Element

        if (this.selectionOverlay?.contains(target))
            return

        if (
            isEditableTarget(target)
            || target.closest('button, a, input, textarea, select, .nopan')
            || this.interaction.isInteractiveTarget?.(target)
        )
            return

        if (
            event.shiftKey
            || event.altKey
            || event.ctrlKey
            || event.metaKey
        ) {
            const node = this.hitNode(event)

            if (
                node
                && (event.ctrlKey || event.metaKey)
            ) {
                this.selection.toggle(node.nodeId)
                this.setSelected(this.selection.nodeIds)
            }

            return
        }

        const node = this.hitNode(event)

        if (node)
            this.startDrag(event, node.nodeId)
        else {
            event.preventDefault()
            this.cancelInteraction('replaced')
            this.marquee?.start(event)
        }
    }

    private hitNode(event: MouseEvent): EngineNode | undefined {
        const id = (event.target as Element).closest('[data-canvas-node-id]')?.getAttribute('data-canvas-node-id')
        const nodes = this.scene.scene.nodes

        if (id)
            return nodes.find(node => node.nodeId === id)

        const point = this.clientToWorld({
            x: event.clientX,
            y: event.clientY,
        })

        return Array.from(nodes)
            .reverse().find(node => rectangleContainsPoint(this.scene.getNodeGeometry(node.nodeId)!.hitBounds, point))
    }

    private startDrag(
        event: MouseEvent,
        nodeId: string,
    ): void {
        if (!this.interaction)
            return

        event.preventDefault()
        event.stopPropagation()
        this.cancelInteraction('replaced')
        const nodes = this.scene.scene.nodes
        const plan = computeDragPlan({
            nodes,
            primaryNodeId: nodeId,
            selectedNodeIds: this.selection.nodeIds,
            canDrag: node => this.options.registry.get(node.type)?.geometry.movable ?? false,
        })

        if (!plan.draggedNodeIds.length) {
            this.setSelected([nodeId])

            return
        }

        this.transforming = new Set(plan.draggedNodeIds)
        this.transforms.startDrag({
            event,
            targets: plan.draggedNodeIds.map(
                id => ({
                    nodeId: id,
                    bounds: this.scene.getNodeGeometry(id)!.worldBounds,
                }),
            ),
            threshold: this.interaction.dragThreshold ?? 3,
            lock: () => this.viewport!.lock(),
            onStart: () => {
                if (!this.selection.has(nodeId))
                    this.setSelected([nodeId])
            },
            onChange: () => this.refreshPresentation(),
            onEnd: (
                _event,
                bounds,
                moved,
            ) => {
                this.transforming.clear()

                if (moved)
                    this.commitGeometry(bounds)
                else
                    this.setSelected([nodeId])

                this.refreshPresentation()
            },
            onCancel: () => {
                this.transforming.clear()
                this.refreshPresentation()
            },
        })
    }

    private startResize(
        event: MouseEvent,
        nodeId: string,
        handle: ResizeHandle,
    ): void {
        if (
            event.button !== 0
            || !this.interaction
        )
            return

        const node = this.scene.scene.nodes.find(node => node.nodeId === nodeId)

        if (!node)
            return

        const policy = this.options.registry.get(node.type)?.geometry

        if (!policy)
            return

        event.preventDefault()
        this.cancelInteraction('replaced')
        this.transforming = new Set([nodeId])
        this.transforms.startResize({
            event,
            target: {
                nodeId,
                bounds: this.scene.getNodeGeometry(nodeId)!.worldBounds,
            },
            handle,
            constraints: structuredClone(policy.resize),
            lock: () => this.viewport!.lock(),
            onChange: () => this.refreshPresentation(),
            onEnd: (
                _event,
                bounds,
                moved,
            ) => {
                this.transforming.clear()

                if (moved)
                    this.commitGeometry(bounds)

                this.refreshPresentation()
            },
            onCancel: () => {
                this.transforming.clear()
                this.refreshPresentation()
            },
        })
    }

    private commitGeometry(bounds: ReadonlyMap<string, CanvasEngineRect>): void {
        const snapshot = this.scene.scene
        const byId = buildNodesById(snapshot.nodes)
        const changes = computeGeometryChanges(
            snapshot.nodes,
            bounds,
            {
                geometry: node => this.options.registry.get(node.type)?.geometry,
                worldBounds: node => this.geometry.worldBounds(node, byId),
                collisions: this.options.collisions,
            },
        )

        if (changes.length)
            this.emit({
                kind: 'geometry',
                sceneKey: snapshot.sceneKey,
                revision: snapshot.revision,
                changes,
            })
    }

    cancelInteraction(reason: GestureCancelReason = 'replaced'): void {
        this.gestures.cancelAll(reason)
        this.connections?.cancelTransientConnection()
    }

    installExtension(extension: CanvasExtension): Dispose {
        if (this.destroyed)
            throw new Error('Canvas controller is disposed')

        if (
            !extension.id.trim()
            || this.extensions.has(extension.id)
        )
            throw new Error(`Invalid or duplicate canvas extension: ${extension.id}`)

        const context = this.scene.createContext()
        const scope = new Lifetime()
        scope.own(() => context.destroy())
        const dispose = this.lifetime.own(() => {
            this.extensions.delete(extension.id)
            scope.destroy()
        })
        this.extensions.set(extension.id, dispose)

        try {
            scope.own(
                extension.mount(
                    Object.assign(context, { overlayRoot: context.contentRoot }),
                ),
            )
        } catch (error) {
            dispose()

            throw error
        }

        return dispose
    }

    private emit(intent: CanvasIntent): void {
        if (this.destroyed)
            return

        try {
            this.options.onIntent(intent)
        } catch (error) {
            this.options.onError(error)
        }
    }

    destroy(): void {
        if (this.destroyed)
            return

        this.destroyed = true
        this.lifetime.destroy()
    }
}
