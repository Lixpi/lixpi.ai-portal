import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Only the outermost call owns a complete chain replacement. Visiting nested links as well
// would produce overlapping fixes for the same member chain.
const isNestedCallChain = (node): boolean =>
    node.parent?.type === 'MemberExpression' && node.parent.object === node && node.parent.parent?.type === 'CallExpression' && node.parent.parent.callee === node.parent

// Decompose a fluent call into its base expression and source-preserving member segments,
// while counting `.attr()` calls that trigger the D3 and SVG layout rule.
const getCallChain = (
    node,
    sourceCode,
): {
    attrCount: number
    base: unknown
    segments: string[]
} => {
    const segments: string[] = []
    let attrCount = 0
    let current = node

    while (
        current.type === 'CallExpression'
        && current.callee.type === 'MemberExpression'
        && !current.callee.computed
        && current.callee.property.type === 'Identifier'
    ) {
        if (current.callee.property.name === 'attr')
            attrCount++

        segments.unshift(
            sourceCode.text.slice(current.callee.object.range[1], current.range[1]).trim(),
        )
        current = current.callee.object
    }

    return {
        attrCount,
        base: current,
        segments,
    }
}

// Put D3 and SVG chains with several `.attr()` calls on separate lines. A chain used as a
// sole argument receives the extra indentation and surrounding commas of argument layout.
export const preferMultilineAttrChain = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            preferMultilineChain: 'Split chained SVG attributes across lines.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            CallExpression(node) {
                if (isNestedCallChain(node))
                    return

                const chain = getCallChain(node, sourceCode)

                if (
                    chain.attrCount <= 1
                    || chain.segments.length === 0
                )
                    return

                if (sourceCode.getCommentsInside(node).length > 0)
                    return

                const parent = node.parent
                const isOnlyCallArgument = (
                    parent?.type === 'CallExpression'
                    && parent.arguments.length === 1
                    && parent.arguments[0] === node
                )
                const indentation = getLineIndentation(sourceCode.text, isOnlyCallArgument ? parent.range[0] : node.range[0])
                const baseText = sourceCode.getText(chain.base)
                const chainIndentation = `${indentation}${isOnlyCallArgument ? '        ' : '    '}`
                const canonicalChain = `${baseText}\n${chain.segments.map(segment => `${chainIndentation}${segment}`).join('\n')}`
                let replacement = canonicalChain
                let replacementRange = node.range

                if (isOnlyCallArgument) {
                    const parentTokens = sourceCode.getTokens(parent)
                    const openParenthesis = parentTokens.find(token => token.value === '(' && token.range[0] < node.range[0])
                    const closeParenthesis = parentTokens.findLast(token => token.value === ')' && token.range[1] > node.range[1])

                    if (
                        !openParenthesis
                        || !closeParenthesis
                    )
                        return

                    replacement = `\n${indentation}    ${canonicalChain},\n${indentation}`
                    replacementRange = [openParenthesis.range[1], closeParenthesis.range[0]]
                }

                if (sourceCode.text.slice(replacementRange[0], replacementRange[1]) === replacement)
                    return

                context.report({
                    node,
                    messageId: 'preferMultilineChain',
                    fix: fixer => fixer.replaceTextRange(replacementRange, replacement),
                })
            },
        }
    },
})
