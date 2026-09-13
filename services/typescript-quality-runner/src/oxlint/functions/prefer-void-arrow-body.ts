import { defineRule } from '@oxlint/plugins'
import { directVoidExpressionTypes } from './arrow-body-text.ts'

// `window.open()` is effect-oriented even though browsers return a Window handle, so a
// concise callback must explicitly discard that value.
const isWindowOpenCall = (node): boolean => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.object.type === 'Identifier'
    && node.callee.object.name === 'window'
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === 'open'

// Ensure concise arrows declared as void, plus known effect-only concise arrows, cannot
// accidentally expose the value of an assignment, update, or `window.open()` call.
export const preferVoidArrowBody = defineRule({
    meta: {
        type: 'problem',
        fixable: 'code',
        messages: {
            discardReturnValue: 'Discard the expression value so this arrow function still returns undefined.',
        },
        schema: [],
    },
    create(context) {
        return {
            ArrowFunctionExpression(node) {
                if (node.body.type === 'BlockStatement')
                    return

                if (
                    node.body.type === 'UnaryExpression'
                    && node.body.operator === 'void'
                )
                    return

                const hasVoidReturnType = node.returnType?.typeAnnotation?.type === 'TSVoidKeyword'
                const isEffectOnlyExpression = (
                    node.body.type === 'AssignmentExpression'
                    || node.body.type === 'UpdateExpression'
                    || isWindowOpenCall(node.body)
                )

                if (
                    !hasVoidReturnType
                    && !isEffectOnlyExpression
                )
                    return

                context.report({
                    node: node.body,
                    messageId: 'discardReturnValue',
                    fix: fixer => directVoidExpressionTypes.has(node.body.type)
                        ? fixer.insertTextBefore(node.body, 'void ')
                        : [
                            fixer.insertTextBefore(node.body, 'void ('),
                            fixer.insertTextAfter(node.body, ')'),
                        ],
                })
            },
        }
    },
})
