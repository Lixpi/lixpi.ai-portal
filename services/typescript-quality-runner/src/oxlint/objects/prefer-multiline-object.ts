import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// An object literal holding more than one property reads as a list, and a list goes one
// item to a line, the same way a named import list does.
export const preferMultilineObject = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            preferMultilineObject: 'Split object literals with more than one property across lines.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            ObjectExpression(node) {
                if (node.properties.length <= 1)
                    return

                if (sourceCode.getCommentsInside(node).length > 0)
                    return

                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const propertyIndentation = `${indentation}    `
                const replacement = `{\n${node.properties.map(property => `${propertyIndentation}${sourceCode.getText(property)},`).join('\n')}\n${indentation}}`

                if (sourceCode.getText(node) === replacement)
                    return

                context.report({
                    node,
                    messageId: 'preferMultilineObject',
                    fix: fixer => fixer.replaceText(node, replacement),
                })
            },
        }
    },
})
