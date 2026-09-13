import { applyStyle } from '@lixpi/ui-primitives/dom'
import {
    type Dispose,
    type SceneSnapshot,
} from '../../shared/index.ts'
import {
    type CanvasDrawingScope,
} from '../rendering/drawing-scope.ts'
import { Lifetime } from './lifetime.ts'
import {
    type CanvasView,
    type ComponentContext,
} from './node-registry.ts'

export type SceneContextHost = {
    subscribeScene: (callback: (scene: SceneSnapshot) => void) => Dispose
    subscribeView: (callback: (view: CanvasView) => void) => Dispose
    mountOverlay: (
        element: HTMLElement,
        space: 'world' | 'screen',
    ) => Dispose
}

export class SceneContext implements ComponentContext {
    private readonly lifetime = new Lifetime()
    private destroyed = false

    constructor(
        readonly contentRoot: HTMLElement,
        private readonly drawing: CanvasDrawingScope,
        private readonly host: SceneContextHost,
        onDestroy: Dispose,
    ) {
        this.lifetime.own(onDestroy)
        this.lifetime.own(() => contentRoot.remove())
        drawing.signal.addEventListener(
            'abort',
            this.destroy,
            { once: true },
        )
    }

    get resources() {
        return this.drawing.resources
    }
    get media() {
        return this.drawing.media
    }
    get layers() {
        return this.drawing.layers
    }
    get signal() {
        return this.drawing.signal
    }
    // Canvas extensions mount their overlays into the context's own content root.
    get overlayRoot() {
        return this.contentRoot
    }
    requestFrame: ComponentContext['requestFrame'] = callback => this.drawing.requestFrame(callback)
    invalidate: ComponentContext['invalidate'] = bounds => this.drawing.invalidate(bounds)

    subscribeScene: ComponentContext['subscribeScene'] = callback => {
        this.signal.throwIfAborted()

        return this.lifetime.own(
            this.host.subscribeScene(callback),
        )
    }

    subscribeView: ComponentContext['subscribeView'] = callback => {
        this.signal.throwIfAborted()

        return this.lifetime.own(
            this.host.subscribeView(callback),
        )
    }

    mountOverlay: ComponentContext['mountOverlay'] = (
        element,
        space,
    ) => {
        this.signal.throwIfAborted()

        return this.lifetime.own(
            this.host.mountOverlay(element, space),
        )
    }

    setGeometry(bounds: {
        x: number
        y: number
        width: number
        height: number
    }): void {
        applyStyle(
            this.contentRoot,
            {
                left: `${bounds.x}px`,
                top: `${bounds.y}px`,
                width: `${bounds.width}px`,
                height: `${bounds.height}px`,
            },
        )
    }

    destroy = (): void => {
        if (this.destroyed)
            return

        this.destroyed = true
        this.signal.removeEventListener('abort', this.destroy)

        try {
            this.lifetime.destroy()
        } finally {
            this.drawing.destroy()
        }
    }
}
