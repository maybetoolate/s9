--- s9.nvim — a Neovim companion for a self-hosted s9 instance.
---
--- The plugin talks to the s9 REST API: it lists workflows, starts
--- production and test runs, watches executions, and exposes the recovery
--- operations (retry a step, rerun an execution, resolve an unknown outcome,
--- cancel a run) without leaving the editor.
local config = require('s9.config')
local session = require('s9.session')
local ui = require('s9.ui')

local M = {}

---@param opts S9Config|nil
---@return S9Config
function M.setup(opts)
  local options = config.setup(opts)
  M.apply_keymaps(options.keymaps)
  return options
end

local actions = {
  workflows = function()
    M.workflows()
  end,
  runs = function()
    M.runs()
  end,
  login = function()
    M.login()
  end,
  logout = function()
    M.logout()
  end,
  status = function()
    M.status()
  end,
  dashboard = function()
    M.dashboard()
  end,
}

--- Applies the opt-in global keymaps from `setup({ keymaps = ... })`.
---@param maps table<string, string>|nil
function M.apply_keymaps(maps)
  for name, lhs in pairs(maps or {}) do
    if actions[name] and type(lhs) == 'string' then
      vim.keymap.set('n', lhs, actions[name], { desc = 'S9: ' .. name })
    end
  end
end

--- Signs in and stores the session cookie. The password is never persisted.
---@param opts table|nil { email?: string }
function M.login(opts)
  opts = opts or {}

  local function submit(email)
    email = vim.trim(email or '')
    if email == '' then
      return ui.notify('an email is required', vim.log.levels.WARN)
    end

    local password = vim.fn.inputsecret('s9 password: ')
    if password == '' then
      return ui.notify('sign-in cancelled')
    end

    ui.notify('signing in…')

    require('s9.api').login(email, password, function(err, me)
      if err then
        return ui.error(err)
      end

      local user = me and me.user or {}
      local workspace = me and me.workspace or {}
      ui.notify(
        string.format(
          'signed in as %s · %s (%s)',
          user.email or 'unknown',
          workspace.name or 'unknown workspace',
          (me and me.role) or 'unknown role'
        )
      )
    end)
  end

  if opts.email then
    submit(opts.email)
  else
    ui.input({ prompt = 's9 email: ' }, submit)
  end
end

function M.logout()
  if not session.authenticated() then
    return ui.notify('not signed in')
  end

  require('s9.api').logout(function(err)
    if err and err.status ~= 401 then
      return ui.error(err)
    end
    ui.notify('signed out')
  end)
end

function M.status()
  if not session.authenticated() then
    return ui.notify('not signed in; run :S9 login')
  end

  require('s9.api').me(function(err, me)
    if err then
      return ui.error(err)
    end

    local user = me.user or {}
    local workspace = me.workspace or {}
    ui.notify(string.format('%s · %s · %s', user.email or '?', workspace.name or '?', me.role or '?'))
  end)
end

---@param search string|nil
function M.workflows(search)
  require('s9.workflows').list({ search = search })
end

---@param workflow_id string|nil
function M.runs(workflow_id)
  require('s9.executions').list({ workflow_id = workflow_id })
end

---@param id string
function M.execution(id)
  require('s9.executions').detail(id)
end

--- Starts a run (or a test run) for one workflow id.
---@param id string
---@param is_test boolean
function M.run(id, is_test)
  require('s9.api').workflow(id, function(err, workflow)
    if err then
      return ui.error(err)
    end

    local workflows = require('s9.workflows')
    if is_test then
      workflows.test(workflow)
    else
      workflows.run(workflow)
    end
  end)
end

function M.dashboard()
  ui.open_url('/dashboard')
end

function M.help()
  local lines = {
    ':S9 login [email]     sign in and store the session cookie',
    ':S9 logout            end the session',
    ':S9 status            show the current user and role',
    ':S9 workflows [text]  list workflows, optionally filtered',
    ':S9 runs [workflow]   list executions, optionally per workflow',
    ':S9 execution <id>    open one execution',
    ':S9 run <workflow>    start a production run',
    ':S9 test <workflow>   start a test run against the draft',
    ':S9 dashboard         open the web dashboard in a browser',
    '',
    'Inside a workflow view:  r run · t test · p pause/resume · R runs',
    '                         v versions · o browser · gr refresh · q close',
    '',
    'Inside an execution view: r retry step · R rerun · x resolve unknown',
    '                          c cancel · o browser · gr refresh · q close',
    '',
    'Configuration: require("s9").setup({ base_url = "..." })',
  }

  ui.open({
    lines = lines,
    title = ' s9 ',
    width = 0.7,
    height = #lines + 2,
    footer = ui.footer({ { 'q', 'close' } }),
  })
end

local subcommands = {
  'login',
  'logout',
  'status',
  'workflows',
  'runs',
  'execution',
  'run',
  'test',
  'dashboard',
  'help',
}

---@return string[]
function M.complete()
  return subcommands
end

--- Entry point used by `:S9`.
---@param fargs string[]
---@param args string
function M.command(fargs, args)
  local sub = (fargs[1] or 'workflows'):lower()
  local rest = vim.trim((args or ''):sub(#sub + 1))

  if sub == 'login' then
    return M.login({ email = rest ~= '' and rest or nil })
  elseif sub == 'logout' then
    return M.logout()
  elseif sub == 'status' then
    return M.status()
  elseif sub == 'workflows' then
    return M.workflows(rest ~= '' and rest or nil)
  elseif sub == 'runs' then
    return M.runs(rest ~= '' and rest or nil)
  elseif sub == 'execution' then
    if rest == '' then
      return ui.notify('usage: :S9 execution <id>', vim.log.levels.ERROR)
    end
    return M.execution(rest)
  elseif sub == 'run' then
    if rest == '' then
      return ui.notify('usage: :S9 run <workflow-id>', vim.log.levels.ERROR)
    end
    return M.run(rest, false)
  elseif sub == 'test' then
    if rest == '' then
      return ui.notify('usage: :S9 test <workflow-id>', vim.log.levels.ERROR)
    end
    return M.run(rest, true)
  elseif sub == 'dashboard' or sub == 'open' then
    return M.dashboard()
  elseif sub == 'help' then
    return M.help()
  end

  ui.notify('unknown command: ' .. sub .. ' (try :S9 help)', vim.log.levels.ERROR)
end

return M
