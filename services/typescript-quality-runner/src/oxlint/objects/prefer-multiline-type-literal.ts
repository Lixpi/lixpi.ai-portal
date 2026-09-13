import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Render each member of a multi-member inline type on its own line and remove separators
// that are unnecessary under the repository's line-based type style.
export const preferMultilineTypeLiteral = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            preferMultilineTypeLiteral: 'Split type literals with more than one member across lines.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            TSTypeLiteral(node) {
                if (node.members.length <= 1)
                    return

                if (sourceCode.getCommentsInside(node).length > 0)
                    return

                const openBrace = sourceCode.getFirstToken(node)
                const closeBrace = sourceCode.getLastToken(node)

                if (
                    openBrace?.value !== '{'
                    || closeBrace?.value !== '}'
                )
                    return

                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const memberIndentation = `${indentation}    `
                const replacement = `{\n${node.members.map(
                    member => {
                        const lastToken = sourceCode.getLastToken(member)
                        const memberEnd = (
                            lastToken?.value === ';'
                            || lastToken?.value === ','
                        )
                            ? lastToken.range[0]
                            : member.range[1]

                        return `${memberIndentation}${sourceCode.text.slice(member.range[0], memberEnd)}`
                    },
                ).join('\n')}\n${indentation}}`

                if (sourceCode.getText(node) === replacement)
                    return

                context.report({
                    node,
                    messageId: 'preferMultilineTypeLiteral',
                    fix: fixer => fixer.replaceText(node, replacement),
                })
            },
        }
    },
})
