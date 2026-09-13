import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'
import {
    compactIfStatementTypes,
    countLogicalEvaluations,
    unwrapParenthesizedExpression,
} from './condition-text.ts'

// Remove braces around a single simple `if` or `else` statement and normalize direct compact
// bodies onto the following indented line. Comments and multiline statements keep braces.
export const preferCompactIf = defineRule({
    meta: {
        type: 'suggestion',
        fixable: 'code',
        messages: {
            preferCompactBody: 'Use the simple statement directly as the if body.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            IfStatement(node) {
                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const bodyIndentation = `${indentation}    `
                const conditionRuleOwnsConsequentBoundary = (
                    unwrapParenthesizedExpression(node.test).type === 'LogicalExpression'
                    && countLogicalEvaluations(node.test) > 1
                    && sourceCode.getCommentsInside(node.test).length === 0
                )
                const blocks = [node.consequent, node.alternate].filter(statement => statement?.type === 'BlockStatement')

                for (const block of blocks) {
                    if (
                        block.type !== 'BlockStatement'
                        || block.body.length !== 1
                    )
                        continue

                    const statement = block.body[0]

                    if (!compactIfStatementTypes.has(statement.type))
                        continue

                    if (sourceCode.getText(statement).includes('\n'))
                        continue

                    if (sourceCode.getCommentsInside(block).length > 0)
                        continue

                    context.report({
                        node: block,
                        messageId: 'preferCompactBody',
                        fix: fixer =>
                            fixer.replaceText(
                                block,
                                `\n${bodyIndentation}${sourceCode.getText(statement)}${(
                                    block === node.consequent
                                    && node.alternate
                                )
                                    ? `\n${indentation}`
                                    : ''}`,
                            ),
                    })
                }

                const directStatements = [node.consequent, node.alternate].filter(
                    statement => statement && statement.type !== 'BlockStatement' && compactIfStatementTypes.has(statement.type),
                )

                for (const statement of directStatements) {
                    if (
                        statement === node.consequent
                        && conditionRuleOwnsConsequentBoundary
                    )
                        continue

                    const precedingToken = sourceCode.getTokenBefore(statement)

                    if (!precedingToken)
                        continue

                    const whitespaceRange = [precedingToken.range[1], statement.range[0]]
                    const whitespace = sourceCode.text.slice(whitespaceRange[0], whitespaceRange[1])
                    const replacement = `\n${bodyIndentation}`

                    if (
                        whitespace === replacement
                        || whitespace.trim().length > 0
                    )
                        continue

                    context.report({
                        node: statement,
                        messageId: 'preferCompactBody',
                        fix: fixer => fixer.replaceTextRange(whitespaceRange, replacement),
                    })
                }
            },
        }
    },
})
