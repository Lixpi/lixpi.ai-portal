// Calls, constructors, and tagged templates can take a leading `void` directly. Other
// expressions need parentheses so `void` applies to the complete expression.
export const directVoidExpressionTypes = new Set([
    'CallExpression',
    'NewExpression',
    'TaggedTemplateExpression',
])

// Preserve an existing `void`, otherwise add the least syntax needed to discard a value
// without changing evaluation order.
const getVoidExpressionText = (
    expressionNode,
    sourceCode,
): string => {
    const expression = sourceCode.getText(expressionNode)

    if (
        expressionNode.type === 'UnaryExpression'
        && expressionNode.operator === 'void'
    )
        return expression

    return directVoidExpressionTypes.has(expressionNode.type)
        ? `void ${expression}`
        : `void (${expression})`
}

// Convert the only statement in an arrow block into a concise body. Expression statements
// are made explicitly void, and returned object literals keep grouping parentheses.
export const getConciseArrowBodyText = (
    statement,
    sourceCode,
): string => {
    const isExpressionStatement = statement.type === 'ExpressionStatement'
    const expressionNode = isExpressionStatement ? statement.expression : statement.argument
    const expression = sourceCode.getText(expressionNode)

    if (isExpressionStatement)
        return getVoidExpressionText(expressionNode, sourceCode)

    return expressionNode.type === 'ObjectExpression' ? `(${expression})` : expression
}
