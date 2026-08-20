# dsh-task-resilience

DSH browser-side task recovery visibility plugin.

It adds a status bar above the composer for:

- an active task that is waiting for model or tool output;
- provider/network retries, including retry count, delay, error code, and reason;
- a disconnected DSH host connection and its recovery;
- a terminal task error, including errors hidden by the normal retry UI.

The DeepSeek retry policy is configured in the web profile rather than this
plugin. The local profile currently uses `maxRetries: 10000` with exponential
backoff capped at 30 seconds.

The plugin deliberately does not replay a whole turn after a disconnect.
Replaying a partially completed turn could repeat file writes or tool commands;
the built-in provider retry resumes only the failed model request.

Browser diagnostics:

```js
window.dshTaskResilience.status()
window.dshTaskResilience.refresh()
```
