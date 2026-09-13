import htm from 'htm/mini'

type StyleObject = Partial<CSSStyleDeclaration>
type DataObject = Record<string, string | number>
type EventHandler = (event: Event) => void

type ElementProps = {
    innerHTML?: string
    className?: string
    class?: string
    style?: StyleObject
    data?: DataObject
    [key: string]: any
}

class DOMTemplateBuilder {
    private createElement = (
        tag: string,
        props?: ElementProps,
        ...children: any[]
    ): HTMLElement => {
        const element = document.createElement(tag)

        if (!props) {
            this.appendChildren(element, children)

            return element
        }

        this.applyProperties(element, props)
        this.appendChildren(element, children)

        return element
    }

    private applyProperties(
        element: HTMLElement,
        props: ElementProps,
    ): void {
        for (const [key, value] of Object.entries(props)) {
            switch (true) {
                case key.startsWith('on') && typeof value === 'function':
                    this.attachEventListener(
                        element,
                        key,
                        value as EventHandler,
                    )

                    break
                case key === 'innerHTML':
                    element.innerHTML = value as string

                    break
                case key === 'className' || key === 'class':
                    element.className = value as string

                    break
                case key === 'style' && typeof value === 'object':
                    Object.assign(element.style, value as StyleObject)

                    break
                case key === 'data' && typeof value === 'object':
                    this.applyDataAttributes(element, value as DataObject)

                    break
                default:
                    element.setAttribute(
                        key,
                        String(value),
                    )
            }
        }
    }

    private attachEventListener(
        element: HTMLElement,
        eventKey: string,
        handler: EventHandler,
    ): void {
        const eventType = eventKey.slice(2).toLowerCase()
        element.addEventListener(eventType, handler)
    }

    private applyDataAttributes(
        element: HTMLElement,
        dataObj: DataObject,
    ): void {
        for (const [dataKey, dataValue] of Object.entries(dataObj)) {
            element.dataset[dataKey] = String(dataValue)
        }
    }

    private appendChildren(
        element: HTMLElement,
        children: any[],
    ): void {
        for (const child of children.flat()) {
            if (child != null)
                element.append(child)
        }
    }

    getTemplateFunction() {
        return (htm as unknown as typeof htm.default).bind(this.createElement)
    }

    getCreateElementFunction() {
        return this.createElement
    }
}

const templateBuilder = new DOMTemplateBuilder()

export const html = templateBuilder.getTemplateFunction()
export const createEl = templateBuilder.getCreateElementFunction()

// Applies multiple style properties to an existing element at once.
// Use this instead of setting element.style.X = ... line by line.
//
// Example:
//   applyStyle(el, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
export const applyStyle = (
    element: HTMLElement | SVGElement,
    styles: StyleObject,
): void => void Object.assign(element.style, styles)
