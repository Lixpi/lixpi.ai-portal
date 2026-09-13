import { vi } from 'vitest'
import {
    type EditorView,
} from 'prosemirror-view'
import {
    type EditorState,
} from 'prosemirror-state'

// Mock EditorView for testing bubble menu and image selection
// This provides the minimal interface needed for most tests

export type MockEditorViewOptions = {
    state: EditorState
    coordsAtPos?: (pos: number) => {
        left: number
        right: number
        top: number
        bottom: number
    }
    nodeDOM?: (pos: number) => HTMLElement | null
    hasFocus?: () => boolean
    editable?: boolean
}

export const createMockEditorView = (options: MockEditorViewOptions): EditorView => {
    const dom = document.createElement('div')
    dom.className = 'ProseMirror'

    const mockView = {
        state: options.state,
        dom,
        dispatch: vi.fn((tr) => {
            // Update state on dispatch
            mockView.state = mockView.state.apply(tr)
        }),
        coordsAtPos: options.coordsAtPos ?? vi.fn((pos: number) => ({
            left: pos * 10,
            right: pos * 10 + 5,
            top: 100,
            bottom: 120,
        })),
        nodeDOM: options.nodeDOM ?? vi.fn(() => null),
        hasFocus: options.hasFocus ?? vi.fn(() => true),
        editable: options.editable ?? true,
        focus: vi.fn(),
    }

    return mockView as unknown as EditorView
}

// Mock DOMRect for getBoundingClientRect
export type MockDOMRectOptions = {
    top?: number
    left?: number
    width?: number
    height?: number
}

export const mockDOMRect = (element: HTMLElement, options: MockDOMRectOptions = {}): void => {
    const {
        top = 0,
        left = 0,
        width = 100,
        height = 100,
    } = options

    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        top,
        left,
        width,
        height,
        bottom: top + height,
        right: left + width,
        x: left,
        y: top,
        toJSON: () => ({}),
    })
}

// Create mock image element for image positioning tests
export const createMockImageElement = (options: MockDOMRectOptions = {}): HTMLImageElement => {
    const img = document.createElement('img')
    img.src = 'test-image.png'
    mockDOMRect(img, options)

    return img
}

// Create mock image wrapper (figure element) for ImageNodeView tests
export const createMockImageWrapper = (options: MockDOMRectOptions = {}): HTMLElement => {
    const figure = document.createElement('figure')
    figure.className = 'pm-image-wrapper pm-image-align-left pm-image-wrap-none'

    const img = document.createElement('img')
    img.src = 'test-image.png'
    figure.appendChild(img)

    mockDOMRect(figure, options)
    mockDOMRect(img, options)

    return figure
}

// Create EditorView mock that returns a specific image element
export const createMockViewWithImage = (
    state: EditorState,
    imageRect: MockDOMRectOptions = {
        top: 100,
        left: 50,
        width: 400,
        height: 300,
    },
): EditorView => {
    const imageWrapper = createMockImageWrapper(imageRect)

    return createMockEditorView({
        state,
        nodeDOM: vi.fn(() => imageWrapper),
    })
}

// Reset all mocks
export const resetAllMocks = (): void => {
    vi.clearAllMocks()
    vi.resetModules()
}
