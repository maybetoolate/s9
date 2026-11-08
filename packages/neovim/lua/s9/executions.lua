--- Execution list, detail, live polling and the recovery actions.
local api = require('s9.api')
local config = require('s9.config')
local format = require('s9.format')
local ui = require('s9.ui')

local M = {}

local function is_active(status)
  return status == 'queued' or status == 'running' or status == 'retrying'
end

local function stop_timer(state)
  if state.timer then
    pcall(function()
      state.timer:stop()
      state.timer:close()
    end)
    state.timer = nil
  end
end

--- Re-fetches one execution and repaints the view.
---@param id string
---@param view table
---@param state table
---@param delay integer|nil
---@param silent boolean|nil
function M.refresh(id, view, state, delay, silent)
  local function fetch()
    if state.refreshing then
      return
    end
    state.refreshing = true

    api.execution(id, function(err, execution)
      state.refreshing = false
      if err then
        if not silent then
          ui.error(err)
        end
        return
      end

      state.execution = execution
      local lines, highlights = format.execution_lines(execution)
      view.render(lines, highlights)

      if not is_active(execution.status) then
        stop_timer(state)
      end
    end)
  end

  if delay then
    vim.defer_fn(fetch, delay)
  else
    fetch()
  end
end

local function watch(state, view)
  if not is_active(state.execution.status) then
    return
  end

  local interval = config.get().poll_interval_ms
  local timer = vim.uv.new_timer()
  state.timer = timer

  timer:start(
    interval,
    interval,
    vim.schedule_wrap(function()
      if not vim.api.nvim_buf_is_valid(view.buf) then
        stop_timer(state)
        return
      end
      M.refresh(state.execution.id, view, state, nil, true)
    end)
  )

  vim.api.nvim_create_autocmd('BufWipeout', {
    buffer = view.buf,
    once = true,
    callback = function()
      stop_timer(state)
    end,
  })
end

---@param state table
---@param view table
function M.retry(state, view)
  local execution = state.execution
  local candidates = {}
  for _, step in ipairs(execution.steps or {}) do
    if step.retryable or step.status == 'outcome_unknown' then
      candidates[#candidates + 1] = step
    end
  end

  if #candidates == 0 then
    return ui.notify('no step can be retried', vim.log.levels.WARN)
  end

  local function retry(step)
    local warning = step.safeToRepeat and 'The step runs again; successful steps are not repeated.'
      or 'This action may not be safe to repeat.'

    ui.confirm(string.format('Retry step "%s"?\n%s', step.stepKey, warning), function()
      api.retry(execution.id, step.stepKey, function(err, result)
        if err then
          return ui.error(err)
        end

        ui.notify(result and result.duplicate and 'a retry for this step already exists' or 'retry accepted')
        M.refresh(execution.id, view, state, 300)
      end)
    end)
  end

  if #candidates == 1 then
    retry(candidates[1])
    return
  end

  ui.select(candidates, 'Retry which step?', function(step)
    local error_text = format.error_text(step.error)
    return string.format('%s  ·  %s%s', step.stepKey, step.status, error_text and ('  ·  ' .. error_text) or '')
  end, retry)
end

---@param state table
function M.rerun(state)
  local execution = state.execution

  ui.confirm(
    'Rerun the whole execution?\nEvery step runs again, including the ones that already succeeded.',
    function()
      api.rerun(execution.id, {}, function(err, result)
        if err then
          return ui.error(err)
        end

        local new_id = result and result.executionId
        if not new_id then
          return ui.notify('the rerun was accepted but the API returned no execution id', vim.log.levels.WARN)
        end

        ui.notify('rerun queued: ' .. new_id:sub(1, 8))
        M.detail(new_id)
      end)
    end
  )
end

---@param state table
---@param view table
function M.cancel(state, view)
  local execution = state.execution

  ui.confirm('Cancel this execution?', function()
    api.cancel(execution.id, function(err)
      if err then
        return ui.error(err)
      end

      ui.notify('cancellation requested')
      M.refresh(execution.id, view, state, 300)
    end)
  end)
end

---@param state table
---@param view table
function M.resolve(state, view)
  local unknown = {}
  for _, step in ipairs(state.execution.steps or {}) do
    if step.status == 'outcome_unknown' then
      unknown[#unknown + 1] = step
    end
  end

  if #unknown == 0 then
    return ui.notify('no step has an unknown outcome', vim.log.levels.WARN)
  end

  ui.select(unknown, 'Resolve which step?', function(step)
    return string.format('%s  ·  %s', step.stepKey, format.error_text(step.error) or 'outcome unknown')
  end, function(step)
    ui.select({ 'succeeded', 'failed' }, 'What actually happened?', function(value)
      return value
    end, function(outcome)
      ui.input({ prompt = 'Reason (recorded in the audit log): ' }, function(reason)
        reason = vim.trim(reason)
        if #reason < 3 then
          return ui.notify('a reason of at least 3 characters is required', vim.log.levels.ERROR)
        end

        api.resolve(state.execution.id, step.stepKey, outcome, reason, function(err)
          if err then
            return ui.error(err)
          end

          ui.notify('step resolved as ' .. outcome)
          M.refresh(state.execution.id, view, state, 300)
        end)
      end)
    end)
  end)
end

--- Opens the detail view for one execution.
---@param id string
function M.detail(id)
  api.execution(id, function(err, execution)
    if err then
      return ui.error(err)
    end

    local state = { execution = execution }
    local lines, highlights = format.execution_lines(execution)

    local keys = {
      { 'r', 'retry step', function(view)
        M.retry(state, view)
      end },
      { 'R', 'rerun', function()
        M.rerun(state)
      end },
      { 'x', 'resolve', function(view)
        M.resolve(state, view)
      end },
      { 'c', 'cancel', function(view)
        M.cancel(state, view)
      end },
      { 'o', 'browser', function()
        ui.open_url('/executions/' .. state.execution.id)
      end },
      { 'gr', 'refresh', function(view)
        M.refresh(state.execution.id, view, state)
      end },
    }

    local footer_keys = vim.deepcopy(keys)
    footer_keys[#footer_keys + 1] = { 'q', 'close' }

    local view = ui.open({
      lines = lines,
      highlights = highlights,
      title = ' s9 execution ',
      footer = ui.footer(footer_keys),
      keys = keys,
    })

    watch(state, view)
  end)
end

--- Lists executions, optionally scoped to one workflow.
---@param opts table|nil
function M.list(opts)
  opts = opts or {}

  api.executions({
    workflow_id = opts.workflow_id,
    status = opts.status,
    search = opts.search,
  }, function(err, page)
    if err then
      return ui.error(err)
    end

    local executions = page and page.data or {}
    local prompt = opts.workflow_name and ('Runs · ' .. opts.workflow_name) or 's9 runs'

    ui.select(executions, prompt, format.execution_line, function(execution)
      M.detail(execution.id)
    end)
  end)
end

return M
