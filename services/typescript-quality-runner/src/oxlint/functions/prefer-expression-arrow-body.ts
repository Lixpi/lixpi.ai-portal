import { defineRule } from '@oxlint/plugins'
import { getConciseArrowBodyText } from './arrow-body-text.ts'

// Collapse a one-statement arrow block into an expression body when doing so preserves its
// return contract and no comment or multiline expression would be displaced.
export const preferExpressionArrowBody = defineRule({
    meta: {
        type: 'suggestion',
        fixable: 'code',
        messages: {
            preferExpressionBody: 'Use the expression directly as the arrow function body.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            ArrowFunctionExpression(node) {
                if (
                    node.body.type !== 'BlockStatement'
                    || node.body.body.length !== 1
                )
                    return

                const statement = node.body.body[0]
                const isExpressionStatement = (
                    statement.type === 'ExpressionStatement'
                    && statement.directive == null
                )
                const isReturningExpression = (
                    statement.type === 'ReturnStatement'
                    && statement.argument != null
                )

                if (
                    !isExpressionStatement
                    && !isReturningExpression
                )
                    return

                if (sourceCode.getText(statement).includes('\n'))
                    return

                if (sourceCode.getCommentsInside(node.body).length > 0)
                    return

                context.report({
                    node: node.body,
                    messageId: 'preferExpressionBody',
                    fix: fixer => fixer.replaceText(
                        node.body,
                        getConciseArrowBodyText(statement, sourceCode),
                    ),
                })
            },
        }
    },
})
