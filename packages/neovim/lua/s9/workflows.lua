--- Workflow list, detail and the actions that start a run.
local api = require('s9.api')
local format = require('s9.format')
local ui = require('s9.ui')

local M = {}

local function prompt_input(prompt, on_input)
  ui.input({ prompt = prompt .. ' (JSON) ', default = '{}' }, function(value)
    if vim.trim(value) == '' then
      value = '{}'
    end

    local ok, decoded = pcall(vim.json.decode, value)
    if not ok or type(decoded) ~= 'table' then
      return ui.notify('the input must be a JSON object', vim.log.levels.ERROR)
    end

    on_input(decoded)
  end)
end

local function trigger(workflow, is_test)
  prompt_input(is_test and 'Test input' or 'Run input', function(input)
    local start = is_test and api.test or api.run
    start(workflow.id, input, function(err, result)
      if err then
        return ui.error(err)
      end

      local execution_id = result and result.executionId
      if not execution_id then
        return ui.notify('the run was accepted but the API returned no execution id', vim.log.levels.WARN)
      end

      ui.notify(string.format('%s accepted: %s', is_test and 'test run' or 'run', execution_id:sub(1, 8)))
      require('s9.executions').detail(execution_id)
    end)
  end)
end

---@param id string
---@param view table
---@param state table
function M.refresh(id, view, state)
  api.workflow(id, function(err, workflow)
    if err then
      return ui.error(err)
    end
    state.workflow = workflow
    local lines, highlights = format.workflow_lines(workflow)
    view.render(lines, highlights)
  end)
end

---@param state table
---@param view table|nil
function M.toggle(state, view)
  local workflow = state.workflow
  local action
  if workflow.status == 'published' then
    action = 'pause'
  elseif workflow.status == 'paused' then
    action = 'resume'
  else
    return ui.notify(
      string.format('a %s workflow cannot be paused or resumed', workflow.status or 'unknown'),
      vim.log.levels.WARN
    )
  end

  api.lifecycle(workflow.id, action, function(err)
    if err then
      return ui.error(err)
    end
    ui.notify(action == 'pause' and 'workflow paused' or 'workflow resumed')
    if view then
      M.refresh(workflow.id, view, state)
    end
  end)
end

---@param workflow table
function M.versions(workflow)
  api.versions(workflow.id, function(err, versions)
    if err then
      return ui.error(err)
    end
    if #versions == 0 then
      return ui.notify('this workflow has no published versions')
    end

    ui.select(versions, 'Published versions', function(version)
      return string.format(
        'v%d  ·  %s  ·  %s',
        version.versionNumber,
        format.relative_time(version.publishedAt),
        version.publishedBy or 'unknown'
      )
    end, function(version)
      local lines = {
        string.format('version v%d  ·  published %s', version.versionNumber, format.relative_time(version.publishedAt)),
        '',
      }
      vim.list_extend(lines, vim.split(format.pretty_json(version.definition), '\n', { plain = true }))

      ui.open({
        lines = lines,
        filetype = 'json',
        title = ' s9 version ',
        footer = ui.footer({ { 'q', 'close' } }),
      })
    end)
  end)
end

--- Opens the detail view for one workflow.
---@param id string
function M.detail(id)
  api.workflow(id, function(err, workflow)
    if err then
      return ui.error(err)
    end

    local lines, highlights = format.workflow_lines(workflow)
    local state = { workflow = workflow }

    local keys = {
      { 'r', 'run', function()
        trigger(state.workflow, false)
      end },
      { 't', 'test draft', function()
        trigger(state.workflow, true)
      end },
      { 'p', 'pause/resume', function(view)
        M.toggle(state, view)
      end },
      { 'R', 'runs', function()
        require('s9.executions').list({
          workflow_id = state.workflow.id,
          workflow_name = state.workflow.name,
        })
      end },
      { 'v', 'versions', function()
        M.versions(state.workflow)
      end },
      { 'o', 'browser', function()
        ui.open_url('/workflows/' .. state.workflow.id)
      end },
      { 'gr', 'refresh', function(view)
        M.refresh(state.workflow.id, view, state)
      end },
    }

    local footer_keys = vim.deepcopy(keys)
    footer_keys[#footer_keys + 1] = { 'q', 'close' }

    ui.open({
      lines = lines,
      highlights = highlights,
      title = ' s9 workflow ',
      footer = ui.footer(footer_keys),
      keys = keys,
    })
  end)
end

--- Lists workflows, optionally filtered by a search string.
---@param opts table|nil
function M.list(opts)
  opts = opts or {}

  api.workflows({
    search = opts.search,
    status = opts.status,
    trigger = opts.trigger,
  }, function(err, page)
    if err then
      return ui.error(err)
    end

    local workflows = page and page.data or {}
    ui.select(workflows, 's9 workflows', format.workflow_line, function(workflow)
      M.detail(workflow.id)
    end)
  end)
end

--- Prompts for the input and starts a production run.
---@param workflow table
function M.run(workflow)
  trigger(workflow, false)
end

--- Prompts for the input and starts a test run against the draft.
---@param workflow table
function M.test(workflow)
  trigger(workflow, true)
end

return M
