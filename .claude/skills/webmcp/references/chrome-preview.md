# Chrome Early Preview: Declarative API and Implementation Details

Source: Google Chrome WebMCP Early Preview (Feb 2026, Chrome 146+)

## Table of Contents

- [Chrome Setup](#chrome-setup)
- [Declarative API](#declarative-api)
- [clearContext Method](#clearcontext-method)
- [Tool Annotations](#tool-annotations)
- [Agent Events and CSS](#agent-events-and-css)
- [Tool Declaration Best Practices](#tool-declaration-best-practices)
- [Testing Extension](#testing-extension)

## Chrome Setup

- Chrome version 146.0.7672.0 or higher
- Enable flag: `chrome://flags/#enable-webmcp-testing`
- Relaunch Chrome after enabling

## Declarative API

Automatically transforms standard HTML forms into WebMCP tools using HTML attributes.
No JavaScript required for basic form-to-tool conversion.

### Form Attributes

| Attribute              | Element    | Purpose                                                                |
| ---------------------- | ---------- | ---------------------------------------------------------------------- |
| `toolname`             | `<form>`   | Tool name (required)                                                   |
| `tooldescription`      | `<form>`   | Natural language description (required)                                |
| `toolautosubmit`       | `<form>`   | Auto-submit without user clicking Submit                               |
| `toolparamtitle`       | form field | Override JSON Schema property key (defaults to `name` attribute)       |
| `toolparamdescription` | form field | Override parameter description (defaults to associated `<label>` text) |

### Example

```html
<form toolname="my_tool" tooldescription="A simple declarative tool" action="/submit">
  <label for="text">text label</label>
  <input type="text" name="text" />

  <select
    name="select"
    required
    toolparamtitle="Possible Options"
    toolparamdescription="A nice description"
  >
    <option value="Option 1">This is option 1</option>
    <option value="Option 2">This is option 2</option>
    <option value="Option 3">This is option 3</option>
  </select>

  <button type="submit">Submit</button>
</form>
```

This generates the following tool schema internally:

```json
{
  "name": "my_tool",
  "description": "A simple declarative tool",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "text label" },
      "select": {
        "type": "string",
        "enum": ["Option 1", "Option 2", "Option 3"],
        "title": "Possible Options",
        "description": "A nice description"
      }
    },
    "required": ["select"]
  }
}
```

### Behavior

When an agent calls a declarative tool:

1. Browser focuses the form
2. Browser auto-populates fields with agent-provided values
3. Without `toolautosubmit`: user must manually click Submit
4. With `toolautosubmit`: form submits automatically

### Handling Results with respondWith

Use `SubmitEvent.respondWith(Promise)` to return structured results from declarative tools.
Must call `preventDefault()` first.

```html
<form toolautosubmit toolname="search_tool" tooldescription="Search the web" action="/search">
  <input type="text" name="query" />
</form>
<script>
  document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!myFormIsValid()) {
      if (e.agentInvoked) {
        e.respondWith(myFormValidationErrorPromise);
      }
      return;
    }
    if (e.agentInvoked) {
      e.respondWith(Promise.resolve("Search is done!"));
    }
  });
</script>
```

### SubmitEvent.agentInvoked

Boolean attribute on `SubmitEvent` - `true` when the form was triggered by an AI agent.
Use this to adapt behavior for agent vs human interactions.

## clearContext Method

Remove all registered tools at once:

```js
navigator.modelContext.clearContext();
```

## Tool Annotations

Tools can include an `annotations` object with hints for agents:

```js
navigator.modelContext.registerTool({
  name: "getTodos",
  description: "Get the list of todo items",
  inputSchema: { type: "object", properties: {} },
  annotations: {
    readOnlyHint: "true",
  },
  execute: () => {
    /* ... */
  },
});
```

## Agent Events and CSS

### Window Events

```js
// Fires when agent activates a tool (form fields pre-filled)
window.addEventListener("toolactivated", ({ toolName }) => {
  console.log(`Tool "${toolName}" activated by agent`);
});

// Fires when agent cancels or form.reset() is called
window.addEventListener("toolcancel", ({ toolName }) => {
  console.log(`Tool "${toolName}" cancelled`);
});
```

Both events are non-cancelable.

### CSS Pseudo-Classes

```css
/* Applied to the form element when agent activates a tool */
form:tool-form-active {
  outline: light-dark(blue, cyan) dashed 1px;
  outline-offset: -1px;
}

/* Applied to the submit button when agent activates a tool */
input:tool-submit-active {
  outline: light-dark(red, pink) dashed 1px;
  outline-offset: -1px;
}
```

Both deactivate on form submit, agent cancel, or form reset.

## Tool Declaration Best Practices

### Naming

- Use specific verbs: `create-event` (immediate) vs `start-event-creation-process` (redirects to UI)
- Describe what the tool does and when to use it (positive instructions)
- Avoid negative limitations ("Do not use for...")

### Schema Design

- Accept raw user input - don't require the agent to do math or transformations
- If a user says "11:00 to 15:00", accept strings, don't require minutes-from-midnight
- Use explicit types (`string`, `number`, `enum`)
- Explain the _why_ behind options, not just the _what_

### Error Recovery

- Validate strictly in code, loosely in schema - return descriptive errors so the agent can self-correct
- Handle rate limits gracefully - return meaningful errors or advise manual takeover
- Return from execute _after_ UI has been updated (agents may inspect UI to verify)

### Tool Strategy

- Create atomic, composable tools - avoid similar tools with nuanced differences
- Combine related operations into one tool with input parameters
- Trust the agent's flow control - avoid rigid sequencing instructions

## Testing Extension

Install the [Model Context Tool Inspector Extension](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) to:

- List all registered tools (imperative and declarative)
- Manually execute tools with custom parameters (bypasses LLM non-determinism)
- Test with Gemini API integration (requires API key)

Demo apps:

- [Travel Demo (React, Imperative)](https://googlechromelabs.github.io/webmcp-tools/demos/react-flightsearch/)
- [Le Petit Bistro (Declarative)](https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/)
- [Source code](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos)
