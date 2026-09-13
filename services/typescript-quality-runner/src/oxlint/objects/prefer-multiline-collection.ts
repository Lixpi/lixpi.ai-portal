import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Collection constructors with list-like initializers use repository-specific multiline
// layout instead of the generic constructor argument layout.
const collectionConstructorNames = new Set([
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
])

// Format list initializers passed to Map, Set, WeakMap, and WeakSet as one value per line.
// Sparse arrays and commented lists are left alone because a rewrite could lose structure.
export const preferMultilineCollection = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            preferMultilineCollection: 'Split collection initializers with more than one element across lines.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            NewExpression(node) {
                if (
                    node.callee.type !== 'Identifier'
                    || !collectionConstructorNames.has(node.callee.name)
                )
                    return

                const values = node.arguments[0]

                if (
                    !values
                    || values.type !== 'ArrayExpression'
                    || values.elements.length <= 1
                    || values.elements.some(element => element == null)
                )
                    return

                if (sourceCode.getCommentsInside(values).length > 0)
                    return

                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const valueIndentation = `${indentation}    `
                const replacement = `[\n${values.elements.map(element => `${valueIndentation}${sourceCode.getText(element)},`).join('\n')}\n${indentation}]`

                if (sourceCode.getText(values) === replacement)
                    return

                context.report({
                    node: values,
                    messageId: 'preferMultilineCollection',
                    fix: fixer => fixer.replaceText(values, replacement),
                })
            },
        }
    },
})
