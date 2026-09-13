import htm from 'htm/mini'

export type DocumentElementProperties = Record<string, unknown> & {
    class?: string
    className?: string
    data?: Record<string, string | number>
    style?: Partial<CSSStyleDeclaration>
}

class DocumentTemplateBuilder {
    constructor(private readonly document: Document) {}

    private buildElement = (
        tagName: string,
        properties?: DocumentElementProperties,
        ...children: unknown[]
    ): HTMLElement => {
        const element = this.document.createElement(tagName)

        for (const [key, value] of Object.entries(properties ?? {})) {
            if (
                value === undefined
                || value === null
                || value === false
            )
                continue

            if (
                key === 'class'
                || key === 'className'
            ) {
                element.className = String(value)

                continue
            }

            if (
                key === 'data'
                && typeof value === 'object'
            ) {
                for (const [dataKey, dataValue] of Object.entries(value as Record<string, string | number>)) {
                    element.dataset[dataKey] = String(dataValue)
                }

                continue
            }

            if (
                key === 'style'
                && typeof value === 'object'
            ) {
                Object.assign(element.style, value)

                continue
            }

            if (
                key.startsWith('on')
                && typeof value === 'function'
            ) {
                element.addEventListener(
                    key.slice(2).toLocaleLowerCase('en-US'),
                    value as EventListener,
                )

                continue
            }

            if (
                key === 'textContent'
                || key === 'innerHTML'
            ) {
                element[key] = String(value)

                continue
            }

            element.setAttribute(key, value === true ? '' : String(value))
        }

        for (const child of children.flat(Infinity)) {
            if (
                typeof child === 'string'
                || (child && typeof child === 'object' && 'nodeType' in child)
            )
                element.append(child as Node | string)
            else if (typeof child === 'number')
                element.append(
                    String(child),
                )
        }

        return element
    }

    getTemplateFunction() {
        return (htm as unknown as typeof htm.default).bind(this.buildElement)
    }

    getCreateElementFunction() {
        return this.buildElement
    }
}

export const createDocumentHtml = (document: Document) => new DocumentTemplateBuilder(document).getTemplateFunction()

export const createDocumentEl = (document: Document) => new DocumentTemplateBuilder(document).getCreateElementFunction()
