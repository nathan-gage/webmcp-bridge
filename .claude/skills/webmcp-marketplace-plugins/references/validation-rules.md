# Validation Rules

Scripts are validated on install by `extension/lib/script-validator.js`. Validation has two tiers: **errors** (block install) and **warnings** (shown but don't block).

## Blocked Patterns (errors)

These patterns cause installation to fail:

| Pattern                              | Description                             |
| ------------------------------------ | --------------------------------------- |
| `eval(...)`                          | eval() call                             |
| `new Function(...)`                  | Function constructor                    |
| `document.write(...)`                | document.write() call                   |
| `importScripts(...)`                 | importScripts() call                    |
| `createElement("script")`            | Dynamic script element creation         |
| `new Image().src = ...`              | Image-based data exfiltration           |
| `new WebSocket("wss://external...")` | WebSocket to non-localhost host         |
| `setAttribute("on...")`              | Setting inline event handler attributes |

WebSocket connections to `127.0.0.1` and `localhost` are allowed.

## Obfuscation Detection (warnings)

These heuristics trigger warnings but don't block installation:

| Check                      | Threshold                                    |
| -------------------------- | -------------------------------------------- |
| Long dense lines           | Any line >500 chars with >95% non-whitespace |
| Hex escapes (`\xNN`)       | More than 10 occurrences                     |
| Unicode escapes (`\uNNNN`) | More than 10 occurrences                     |
| `String.fromCharCode`      | More than 3 references                       |
| `atob()` calls             | More than 2 occurrences                      |

## CSP Constraint

The extension's Content Security Policy blocks `eval` and `new Function()`. This means:

- **Syntax validation is not possible at install time.** The validator only does pattern-based scanning.
- Syntax errors surface at injection time via `chrome.scripting.executeScript`.
- Always test scripts in the browser before publishing.

## Workarounds

If your script legitimately needs a pattern that looks like a blocked one:

- **Dynamic code execution**: Restructure to avoid `eval`/`Function`. Use static functions or `JSON.parse` for data.
- **External resources**: Bundle all code in the script file. Don't load external scripts.
- **WebSocket**: Only connect to `127.0.0.1` or `localhost`. For external APIs, use `fetch()` instead.
