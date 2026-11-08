# s9.nvim

A Neovim companion for [s9](../../README.md). List workflows, start a run, watch an execution and recover a
failure without leaving the editor.

The plugin talks to the s9 REST API. It has no Lua dependencies: pickers go through `vim.ui`, so Telescope,
fzf-lua, snacks.nvim or dressing.nvim are used automatically when installed and the built-in prompt is used otherwise.

```
:S9 workflows
  ┌ s9 workflows ─────────────────────────────────────────────┐
  │ Contact form follow-up  published  webhook  3 steps  last …     │
  └──────────────────────────────────────────────────────────────────┘

  s9 workflow
  Contact form follow-up  [published]
  id          1b26de69-…
  trigger     webhook
  steps       3
  version     v2  ·  unpublished changes
  webhook     http://localhost:4100/webhooks/contact-form-endpoint  (signature required)

  r run  ·  t test draft  ·  p pause/resume  ·  R runs  ·  v versions  ·  o browser  ·  gr refresh  ·  q close
```

## Requirements

| Requirement | Why |
| --- | --- |
| Neovim 0.10 or newer | `vim.system`, `vim.uv`, `vim.empty_dict` |
| `curl` on `PATH` | Neovim has no socket API; requests run in an async curl process (7.55+ for `-H @file`) |
| A running s9 API | Defaults to `http://localhost:4100` |

## Install

With lazy.nvim, pointing at this directory in the s9 repository:

```lua
{
  dir = '~/Projects/s9/packages/neovim',
  name = 's9',
  config = function()
    require('s9').setup({
      base_url = 'http://localhost:4100',
      web_url = 'http://localhost:3000',
    })
  end,
}
```

Without a plugin manager:

```lua
vim.opt.runtimepath:append('~/Projects/s9/packages/neovim')
require('s9').setup()
```

`setup()` is optional — the defaults match the development stack from the repository README.

## Sign in

```
:S9 login
```

The plugin asks for the email, then for the password through `inputsecret`. With the seeded development data:

```
email:    operator@s9.local
password: s9-demo-password
```

`:S9 status` shows the current user, workspace and role. `:S9 logout` ends the session on the server and
removes the local cookie.

## Commands

| Command | Description |
| --- | --- |
| `:S9 login [email]` | Sign in and store the session cookie |
| `:S9 logout` | End the session and remove the stored cookie |
| `:S9 status` | Show the signed-in user, workspace and role |
| `:S9 workflows [search]` | Pick a workflow |
| `:S9 runs [workflow-id]` | Pick an execution, optionally scoped to one workflow |
| `:S9 execution <id>` | Open one execution |
| `:S9 run <workflow-id>` | Start a production run |
| `:S9 test <workflow-id>` | Start a test run against the draft |
| `:S9 dashboard` | Open the web dashboard in a browser |
| `:S9 help` | Show the command and key reference |

`:S9` without a subcommand lists workflows.

## Workflow view

| Key | Action |
| --- | --- |
| `r` | Start a production run (prompts for a JSON input, `{}` by default) |
| `t` | Start a test run against the draft (side effects are simulated) |
| `p` | Pause a published workflow, or resume a paused one |
| `R` | List the executions of this workflow |
| `v` | Browse published versions and inspect a definition |
| `o` | Open the workflow in the web app |
| `gr` | Refresh the view |
| `q` / `<Esc>` | Close |

A run opens the execution view immediately, so you can watch the steps.

## Execution view

| Key | Action |
| --- | --- |
| `r` | Retry a failed or unknown step in place (successful steps are not repeated) |
| `R` | Rerun the whole execution (warns that every step runs again) |
| `x` | Resolve a step whose outcome is unknown, with a reason |
| `c` | Cancel a queued or running execution |
| `o` | Open the execution in the web app |
| `gr` | Refresh the view |
| `q` / `<Esc>` | Close |

The view shows the status, version, duration, every step with its attempts, the error classification, the timeline,
and the redacted input and output. While an execution is queued, running or retrying, the view polls the API every
`poll_interval_ms` and stops as soon as it reaches a terminal state (or when the window is closed).

## Configuration

```lua
require('s9').setup({
  base_url = 'http://localhost:4100',
  web_url = 'http://localhost:3000',
  timeout_ms = 15000,
  poll_interval_ms = 2000,
  page_size = 50,
  border = 'rounded',
  width = 0.85,
  height = 0.8,
  open_cmd = nil,
  keymaps = {},
})
```

| Option | Default | Meaning |
| --- | --- | --- |
| `base_url` | `http://localhost:4100` | API base URL, without a trailing slash |
| `web_url` | `http://localhost:3000` | Web app base URL, used by “open in browser” |
| `timeout_ms` | `15000` | Per-request timeout |
| `poll_interval_ms` | `2000` | Refresh interval for in-flight executions |
| `page_size` | `50` | Items requested per list call (the API caps it at 100) |
| `border` | `rounded` | Floating window border |
| `width`, `height` | `0.85`, `0.8` | Ratio of the editor, or an absolute size |
| `open_cmd` | platform default | argv prefix (`{ "firefox" }`) used to open a URL |
| `keymaps` | `{}` | Opt-in global keymaps, see below |

Global keymaps are opt-in:

```lua
require('s9').setup({
  keymaps = {
    workflows = '<leader>fw',
    runs = '<leader>fr',
    login = '<leader>fl',
    status = '<leader>fs',
    dashboard = '<leader>fd',
    logout = false, -- any falsy value disables that mapping
  },
})
```

## How authentication works

s9 uses Better-Auth, and the API only issues an `HttpOnly` session cookie — there is no bearer-token flow for
non-browser clients. The plugin therefore signs in once with an email and password, keeps the resulting cookie, and
sends it on every request.

- The password is used for that single request and is never written anywhere.
- The cookie is stored in `stdpath('data')/s9/session.json` with mode `0600`.
- The cookie is sent through a temporary `0600` header file (`curl -H @file`), never through the process arguments.
- Response bodies are written to `0600` temporary files and deleted after the callback.
- Writes carry the `Origin` header of `web_url`, because Better-Auth rejects cookie-authenticated POSTs without a
  trusted origin. If the API rejects sign-in with `MISSING_OR_NULL_ORIGIN`, set `web_url` to the API's
  `WEB_PUBLIC_URL` (the browser-facing web app origin).
- `:S9 logout` clears both sides. Deleting the file by hand has the same local effect.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `curl exited with 7` / connection refused | Start the API (`pnpm dev:api`) and check `base_url` |
| `unauthorized` / hint to log in | The session expired; run `:S9 login` |
| `MISSING_OR_NULL_ORIGIN` | `web_url` does not match the API's `WEB_PUBLIC_URL` |
| `s9 needs curl` | Install curl and make sure it is on `PATH` |
| `the draft cannot be run` | The draft has validation issues; test runs require a valid draft |
| A production run returns `workflow_not_published` | Publish the workflow or use `t` for a test run |

`:checkhealth s9` checks the Neovim version, curl, both URLs, the stored session and its permissions, and API
readiness.

## Tests

The test suite is headless and dependency-free:

```bash
nvim --headless --clean -u NONE -l tests/run.lua
```

It covers configuration, cookie parsing, header/JSON parsing (including `null` handling), query encoding, error
normalization, the renderers, the request payloads, and command registration. The HTTP client and the API are exercised
with a stubbed transport.

For a live check, start the development stack and drive the real API (sign-in, list, test run, poll, sign-out) from a
scratch script with `XDG_DATA_HOME` pointed at a temporary directory, so your real session is untouched.

## Limitations

- No workflow editor: the plugin reads definitions and starts runs, it does not edit drafts. Use the web builder.
- No pagination controls: a list fetches one page (`page_size`, maximum 100).
- No credential or webhook-secret management.
- Test runs simulate side effects, exactly like the web UI; production runs perform real actions.
- The floating views are read-only and rely on `vim.ui` for pickers and inputs.
