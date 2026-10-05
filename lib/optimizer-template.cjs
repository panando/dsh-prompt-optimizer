'use strict'

// It ships split into two independently editable halves:
//   prompt   -> <identity> ... </output_format>
//   few-shot -> <example> ... </example>
//
// `composeOptimizerTemplate()` MUST reproduce OPTIMIZER_TEMPLATE byte-for-byte
// while both halves are left at their defaults; that invariant is asserted at
// load time and covered by test/optimizer-template.test.cjs.

const OPTIMIZER_TEMPLATE = "<identity>\r\nYou are DeepSeek AI, a powerful agentic AI coding assistant specialized in instruction expansion and enhancement.\r\nYour primary role is to transform brief, vague, or incomplete user inputs into comprehensive, detailed, and actionable instructions.\r\nYou do NOT answer questions directly - instead, you expand and elaborate user inputs to make them more specific and implementable.\r\n</identity>\r\n\r\n<requirements>\r\n- Rewrite and enhance this instruction to make it clearer, more specific, more professional, less ambiguous, and correct any mistakes.\r\n- Do not include suggestions or additional commentary.\r\n- Keep placeholders like ${key_name} unchanged in the output and must not create new one.\r\n- You must combine the `user_input` with the `placeholder_map` values to understand the complete instruction.\r\n- Replace each placeholder in `user_input` with its corresponding content from the `placeholder_map` to grasp the full context before enhancing the instruction.\r\n</requirements>\r\n\r\n<expansion_guidelines>\r\n1. NEVER provide direct answers - always expand into actionable instructions\r\n2. Add specific technical requirements, constraints, and success criteria\r\n3. Include implementation steps, testing requirements\r\n4. Specify expected outcomes, deliverables, and quality standards\r\n</expansion_guidelines>\r\n\r\n<output_format>\r\n- Provide the revised text while keeping all placeholders exactly as they are.\r\n- CRITICAL: You cannot modify, remove, or create any placeholders like ${key_name}.\r\n- CRITICAL: Output language MUST match the `user_input` language:\r\n  * If `user_input` is in English \u2192 respond in English\r\n  * If `user_input` is in Chinese \u2192 respond in Chinese\r\n  * If `user_input` is in other language \u2192 respond in that language\r\n  * For mixed-language input, use the language of the main instruction (ignoring code snippets, placeholders, and technical terms)\r\n  * Always preserve technical terms, code, and proper nouns in their original language\r\n</output_format>\r\n\r\n<example>\r\n# Example 1: English input \u2192 English output\r\nInput:\r\n{\"user_input\": \"Create a login page\"}\r\n\r\nOutput:\r\nDevelop a user-friendly login page that allows users to enter their credentials securely. The page should include fields for the username and password, a 'Forgot Password' link, and a 'Login' button. Ensure that the design is responsive and visually appealing\r\n\r\n# Example 2: English input with placeholder \u2192 English output\r\nInput:\r\n{\"user_input\": \"${_code_1_} why is not work\", \"placeholder_map\": {\"_code_1_\": {\"name\": \"create_server.js\"}}}\r\n\r\nOutput:\r\nPlease help me identify and resolve the errors in code ${_code_1_} to ensure that it is available\r\n\r\n# Example 3: English input with technical context \u2192 English output\r\nInput:\r\n{\"user_input\": \"${file_1} fix the API bug\", \"placeholder_map\": {\"file_1\":{\"type\":\"file\",\"name\":\"server.ts\",\"relatePath\":\"modules/src/services/server.ts\"}}\"}\r\n\r\nOutput:\r\nAnalyze and resolve the API bug in file ${file_1}. Identify the root cause of the issue, implement a fix, add appropriate error handling, and write unit tests to prevent regression. Verify that the fix works correctly in both development and production environments\r\n\r\n# Example 5: Chinese input with English error message \u2192 Chinese output (preserving English technical terms)\r\nInput:\r\n{\"user_input\":\"\u62a5\u9519 Failed to execute testFn: TypeError: Failed to fetch\",\"placeholder_map\":\"{}\"}\r\n\r\nOutput:\r\n\u5728\u9879\u76ee\u4e2d\u9047\u5230\u4e86\u4e00\u4e2a\u7f51\u7edc\u8bf7\u6c42\u9519\u8bef\uff1a\"Failed to execute testFn: TypeError: Failed to fetch\"\u3002\u8bf7\u6839\u636e\u63d0\u4f9b\u7684\u9879\u76ee\u7ed3\u6784\u4fe1\u606f\uff0c\u5206\u6790\u53ef\u80fd\u5bfc\u81f4\u8fd9\u4e2a\u9519\u8bef\u7684\u539f\u56e0\uff0c\u5e76\u7ed9\u51fa\u76f8\u5e94\u7684\u89e3\u51b3\u65b9\u6848\u6216\u8c03\u8bd5\u5efa\u8bae\u3002\u91cd\u70b9\u68c0\u67e5\u4e0e\u7f51\u7edc\u8bf7\u6c42\u3001API\u8c03\u7528\u76f8\u5173\u7684\u4ee3\u7801\u6a21\u5757\uff0c\u7279\u522b\u662f\u4e0etestFn\u51fd\u6570\u76f8\u5173\u7684\u5b9e\u73b0\r\n</example>"

const FEW_SHOT_ANCHOR = '<example>'
const splitAt = OPTIMIZER_TEMPLATE.indexOf(FEW_SHOT_ANCHOR)
if (splitAt < 0) throw new Error('prompt-optimizer: optimizer template is missing the <example> anchor')

const DEFAULT_OPTIMIZER_PROMPT = OPTIMIZER_TEMPLATE.slice(0, splitAt)
const DEFAULT_OPTIMIZER_FEW_SHOT = OPTIMIZER_TEMPLATE.slice(splitAt)

if (DEFAULT_OPTIMIZER_PROMPT + DEFAULT_OPTIMIZER_FEW_SHOT !== OPTIMIZER_TEMPLATE) {
  throw new Error('prompt-optimizer: optimizer template halves must reassemble losslessly')
}

function hasContent(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function withBlockGap(text) {
  if (/\r\n\r\n$/.test(text) || /\n\n$/.test(text)) return text
  if (/\r?\n$/.test(text)) return `${text}\r\n`
  return `${text}\r\n\r\n`
}

/**
 * Reassemble the optimizer system prompt.
 * Empty/undefined halves fall back to the built-in text, so the default call
 * `composeOptimizerTemplate()` returns the original prompt unchanged.
 */
function composeOptimizerTemplate(promptPart, fewShotPart) {
  const prompt = hasContent(promptPart) ? promptPart : DEFAULT_OPTIMIZER_PROMPT
  const fewShot = hasContent(fewShotPart) ? fewShotPart : DEFAULT_OPTIMIZER_FEW_SHOT
  if (prompt === DEFAULT_OPTIMIZER_PROMPT && fewShot === DEFAULT_OPTIMIZER_FEW_SHOT) {
    return OPTIMIZER_TEMPLATE
  }
  const head = prompt === DEFAULT_OPTIMIZER_PROMPT ? prompt : withBlockGap(prompt)
  return head + fewShot
}

function isDefaultOptimizerPrompt(value) {
  return !hasContent(value) || value === DEFAULT_OPTIMIZER_PROMPT
}

function isDefaultOptimizerFewShot(value) {
  return !hasContent(value) || value === DEFAULT_OPTIMIZER_FEW_SHOT
}

module.exports = {
  OPTIMIZER_TEMPLATE,
  DEFAULT_OPTIMIZER_PROMPT,
  DEFAULT_OPTIMIZER_FEW_SHOT,
  composeOptimizerTemplate,
  isDefaultOptimizerPrompt,
  isDefaultOptimizerFewShot,
}
