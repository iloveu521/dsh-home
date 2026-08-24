# dsh-task-resilience

DSH browser-side task recovery visibility plugin.

It adds a status bar above the composer for:

- an active task that is waiting for model or tool output;
- provider/network retries, including retry count, delay, error code, and reason;
- a disconnected DSH host connection and its recovery;
- a terminal task error, including errors hidden by the normal retry UI.

Retry execution is intentionally owned by the native provider adapters rather
than this plugin. Native DeepSeek's policy is configured in the web profile;
each dynamically declared `llm-pi-ai` route configures its policy inside that
provider's `settings.yaml` entry. The local routes use `maxRetries: 10000` with
exponential backoff capped at 30 seconds.

The plugin deliberately does not replay a whole turn after a disconnect.
Replaying a partially completed turn could repeat file writes or tool commands;
the built-in provider retry resumes only the failed model request.

Provider failures are labelled by their actual class. In particular,
`EMPTY_RESPONSE`, `RATE_LIMIT`, and `SERVER` are not presented as network
disconnects; only `TRANSPORT` represents a broken provider connection.

Browser diagnostics:

```js
window.dshTaskResilience.status()
window.dshTaskResilience.refresh()
```
