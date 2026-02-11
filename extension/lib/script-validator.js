"use strict";

/**
 * Dangerous patterns that suggest code is doing something unsafe.
 * Each entry: [regex, description]
 */
const DANGEROUS_PATTERNS = [
  [/\beval\s*\(/, "eval() call"],
  [/\bnew\s+Function\s*\(/, "new Function() constructor"],
  [/\bdocument\.write\s*\(/, "document.write() call"],
  [/\bimportScripts\s*\(/, "importScripts() call"],
  // External resource loading
  [/\bcreateElement\s*\(\s*['"`]script['"`]\s*\)/, "dynamic <script> creation"],
  // Data exfiltration via image/beacon
  [/\bnew\s+Image\s*\(\s*\)\s*\.\s*src\s*=/, "image-based data exfiltration"],
  // WebSocket to external hosts (not localhost)
  [/\bnew\s+WebSocket\s*\(\s*['"`]wss?:\/\/(?!127\.0\.0\.1|localhost)/, "WebSocket to external host"],
  // Inline event handlers that eval
  [/\bsetAttribute\s*\(\s*['"`]on/, "setting inline event handler attribute"],
];

/**
 * Heuristics for detecting obfuscated code.
 * Returns an array of warning strings; empty = code looks clean.
 *
 * @param {string} code
 * @returns {string[]}
 */
function detectObfuscation(code) {
  const warnings = [];

  // Very long lines (>500 chars) with no whitespace suggest minification/obfuscation
  const lines = code.split("\n");
  const longDenseLines = lines.filter((l) => l.length > 500 && l.trim().length / l.length > 0.95);
  if (longDenseLines.length > 0) {
    warnings.push("Contains very long, dense lines suggesting obfuscation or minification");
  }

  // High ratio of hex escapes
  const hexEscapes = (code.match(/\\x[0-9a-fA-F]{2}/g) || []).length;
  if (hexEscapes > 10) {
    warnings.push(`Contains ${hexEscapes} hex escape sequences`);
  }

  // High ratio of unicode escapes
  const unicodeEscapes = (code.match(/\\u[0-9a-fA-F]{4}/g) || []).length;
  if (unicodeEscapes > 10) {
    warnings.push(`Contains ${unicodeEscapes} unicode escape sequences`);
  }

  // Lots of string concatenation building up function/eval-like patterns
  const charCodeRefs = (code.match(/fromCharCode/g) || []).length;
  if (charCodeRefs > 3) {
    warnings.push(`Contains ${charCodeRefs} fromCharCode references`);
  }

  // atob usage (base64 decode — common obfuscation technique)
  const atobRefs = (code.match(/\batob\s*\(/g) || []).length;
  if (atobRefs > 2) {
    warnings.push(`Contains ${atobRefs} atob() calls`);
  }

  return warnings;
}

/**
 * Validates a script for dangerous patterns and obfuscation.
 *
 * @param {string} code - The script source code
 * @param {string} scriptId - Identifier for error messages
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateScript(code, scriptId) {
  const errors = [];
  const warnings = [];

  // Syntax check via Function constructor (does NOT execute)
  try {
    new Function(code);
  } catch (e) {
    errors.push(`Syntax error in "${scriptId}": ${e.message}`);
  }

  // Dangerous pattern scan
  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Dangerous pattern in "${scriptId}": ${description}`);
    }
  }

  // Obfuscation detection
  const obfuscationWarnings = detectObfuscation(code);
  for (const w of obfuscationWarnings) {
    warnings.push(`"${scriptId}": ${w}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates all scripts in a package.
 *
 * @param {Map<string, string>} scripts - scriptId → code
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validatePackageScripts(scripts) {
  const allErrors = [];
  const allWarnings = [];

  for (const [scriptId, code] of scripts) {
    const result = validateScript(code, scriptId);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

if (typeof globalThis.__webmcpExports === "undefined") {
  globalThis.__webmcpExports = {};
}
globalThis.__webmcpExports.scriptValidator = {
  validateScript,
  validatePackageScripts,
  detectObfuscation,
  DANGEROUS_PATTERNS,
};
