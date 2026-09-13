import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Give multi-property destructuring the same one-property-per-line shape as object literals.
// Only the pattern braces are replaced so a following type annotation remains untouched.
export const preferMultilineObjectPattern = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            preferMultilinePattern: 'Split object destructuring with more than one element across lines.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            ObjectPattern(node) {
                if (node.properties.length <= 1)
                    return

                if (sourceCode.getCommentsInside(node).length > 0)
                    return

                const patternEnd = (
                    node.typeAnnotation?.range[0]
                    ?? node.range[1]
                )
                const patternTokens = sourceCode.getTokens(node).filter(token => token.range[1] <= patternEnd)
                const openBrace = patternTokens.find(token => token.value === '{')
                const closeBrace = patternTokens.findLast(token => token.value === '}')

                if (
                    !openBrace
                    || !closeBrace
                )
                    return

                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const propertyIndentation = `${indentation}    `
                const replacement = `{\n${node.properties.map(
                    property => `${propertyIndentation}${sourceCode.getText(property)}${property.type === 'RestElement' ? '' : ','}`,
                ).join('\n')}\n${indentation}}`
                const replacementRange = [openBrace.range[0], closeBrace.range[1]]

                if (sourceCode.text.slice(replacementRange[0], replacementRange[1]) === replacement)
                    return

                context.report({
                    node,
                    messageId: 'preferMultilinePattern',
                    fix: fixer => fixer.replaceTextRange(replacementRange, replacement),
                })
            },
        }
    },
})
