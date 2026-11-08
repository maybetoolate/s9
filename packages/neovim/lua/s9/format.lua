--- Pure formatting helpers.
---
--- Everything here is deterministic and free of side effects so it can be
--- exercised by the headless tests.
local M = {}

--- True when a value is neither missing nor an explicit JSON `null` left as
--- `vim.NIL` by the decoder.
---@param value any
---@return boolean
local function present(value)
  return value ~= nil and value ~= vim.NIL
end

local Builder = {}
Builder.__index = Builder

local function builder()
  return setmetatable({ lines = {}, highlights = {} }, Builder)
end

function Builder:add(text)
  self.lines[#self.lines + 1] = text
  return #self.lines
end

function Builder:span(row, start_col, end_col, group)
  if group and end_col > start_col then
    self.highlights[#self.highlights + 1] = {
      row = row,
      col = start_col,
      end_col = end_col,
      hl = group,
    }
  end
end

function Builder:line(row, group)
  self.highlights[#self.highlights + 1] = { row = row, line = true, hl = group }
end

function Builder:field(label, value, group)
  local text = string.format('%-12s%s', label, value or '')
  local row = self:add(text)
  self:span(row, 0, #label, 'S9Label')
  if group and value and value ~= '' then
    self:span(row, 12, #text, group)
  end
  return row
end

function Builder:wrapped_field(label, text, group, width)
  local wrapped = M.wrap(text, width or 84)
  self:field(label, wrapped[1], group)
  for index = 2, #wrapped do
    local line = string.rep(' ', 12) .. wrapped[index]
    local row = self:add(line)
    self:span(row, 12, #line, group)
  end
end

function Builder:blank()
  self:add('')
end

local status_groups = {
  succeeded = 'S9Ok',
  published = 'S9Ok',
  active = 'S9Ok',
  running = 'S9Busy',
  queued = 'S9Busy',
  retrying = 'S9Busy',
  pending = 'S9Busy',
  failed = 'S9Error',
  timed_out = 'S9Error',
  outcome_unknown = 'S9Warn',
  paused = 'S9Warn',
  draft = 'S9Muted',
  skipped = 'S9Muted',
  cancelled = 'S9Muted',
  archived = 'S9Muted',
}

---@param status string|nil
---@return string highlight group
function M.status_hl(status)
  return status_groups[status] or 'S9Muted'
end

local step_icons = {
  succeeded = '✓',
  failed = '✗',
  retrying = '↻',
  running = '▶',
  queued = '·',
  pending = '·',
  skipped = '–',
  outcome_unknown = '?',
  cancelled = '⊘',
}

---@param status string|nil
---@return string
function M.step_icon(status)
  return step_icons[status] or '·'
end

local function days_from_civil(year, month, day)
  if month <= 2 then
    year = year - 1
  end
  local era = math.floor(year / 400)
  local year_of_era = year - era * 400
  local shifted_month = (month + 9) % 12
  local day_of_year = math.floor((153 * shifted_month + 2) / 5) + day - 1
  local day_of_era = year_of_era * 365 + math.floor(year_of_era / 4) - math.floor(year_of_era / 100) + day_of_year
  return era * 146097 + day_of_era - 719468
end

--- Parses an ISO 8601 timestamp into a Unix epoch.
---
--- `os.time` interprets its argument as local time, which would make every
--- "x minutes ago" wrong outside UTC, so the civil calendar is converted
--- explicitly.
---@param value string|nil
---@return integer|nil
function M.parse_iso(value)
  if type(value) ~= 'string' then
    return nil
  end

  local year, month, day, hour, minute, second =
    value:match('^(%d%d%d%d)%-(%d%d)%-(%d%d)[T ](%d%d):(%d%d):(%d%d)')
  if not year then
    return nil
  end

  local epoch = days_from_civil(tonumber(year), tonumber(month), tonumber(day)) * 86400
    + tonumber(hour) * 3600
    + tonumber(minute) * 60
    + tonumber(second)

  local sign, offset_hour, offset_minute = value:match('([+-])(%d%d):?(%d%d)$')
  if sign then
    local offset = tonumber(offset_hour) * 3600 + tonumber(offset_minute) * 60
    epoch = sign == '+' and epoch - offset or epoch + offset
  end

  return epoch
end

---@param value string|nil
---@param now integer|nil
---@return string
function M.relative_time(value, now)
  local epoch = M.parse_iso(value)
  if not epoch then
    return '—'
  end

  local diff = (now or os.time()) - epoch
  if diff < 10 then
    return 'just now'
  end
  if diff < 60 then
    return string.format('%ds ago', diff)
  end
  if diff < 3600 then
    return string.format('%dm ago', math.floor(diff / 60))
  end
  if diff < 86400 then
    return string.format('%dh ago', math.floor(diff / 3600))
  end
  if diff < 86400 * 30 then
    return string.format('%dd ago', math.floor(diff / 86400))
  end
  return os.date('%Y-%m-%d', epoch)
end

---@param epoch integer|nil
---@return string
function M.clock_time(epoch)
  if not epoch then
    return '—'
  end
  return os.date('%H:%M:%S', epoch)
end

---@param milliseconds number|nil
---@return string
function M.duration(milliseconds)
  if type(milliseconds) ~= 'number' then
    return '—'
  end

  local value = math.max(0, milliseconds)
  if value < 1000 then
    return string.format('%dms', value)
  end
  if value < 60000 then
    return string.format('%.1fs', value / 1000)
  end

  local minutes = math.floor(value / 60000)
  if minutes < 60 then
    return string.format('%dm %02ds', minutes, math.floor((value % 60000) / 1000))
  end

  return string.format('%dh %02dm', math.floor(minutes / 60), minutes % 60)
end

--- Collapses whitespace and shortens a string to `limit` characters.
---@param text string|nil
---@param limit integer
---@return string
function M.truncate(text, limit)
  local value = vim.trim((tostring(text or ''):gsub('%s+', ' ')))
  if vim.fn.strchars(value) <= limit then
    return value
  end
  return vim.fn.strcharpart(value, 0, limit - 1) .. '…'
end

--- Greedy word wrap. Long words are kept intact rather than split mid-byte.
---@param text string
---@param width integer
---@return string[]
function M.wrap(text, width)
  local lines = {}
  local current = ''

  for word in tostring(text):gmatch('%S+') do
    if current == '' then
      current = word
    elseif #current + 1 + #word <= width then
      current = current .. ' ' .. word
    else
      lines[#lines + 1] = current
      current = word
    end
  end

  if current ~= '' then
    lines[#lines + 1] = current
  end
  if #lines == 0 then
    lines[1] = ''
  end

  return lines
end

local function encode_scalar(value)
  if value == nil or value == vim.NIL then
    return 'null'
  end
  if type(value) == 'string' then
    return vim.json.encode(value)
  end
  if type(value) == 'boolean' or type(value) == 'number' then
    return tostring(value)
  end
  local ok, encoded = pcall(vim.json.encode, value)
  return ok and encoded or vim.inspect(value)
end

local function is_list(value)
  local count = 0
  for key in pairs(value) do
    if type(key) ~= 'number' then
      return false
    end
    count = count + 1
  end
  if count == 0 then
    return false
  end
  for index = 1, count do
    if value[index] == nil then
      return false
    end
  end
  return true
end

--- Pretty-prints a decoded JSON value with sorted object keys.
---@param value any
---@param indent integer|nil
---@return string
function M.pretty_json(value, indent)
  indent = indent or 2

  local function render(current, depth)
    local prefix = string.rep(' ', depth * indent)
    if type(current) ~= 'table' then
      return { prefix .. encode_scalar(current) }
    end

    if is_list(current) then
      if #current == 0 then
        return { prefix .. '[]' }
      end
      local lines = { prefix .. '[' }
      for index, item in ipairs(current) do
        local rendered = render(item, depth + 1)
        rendered[#rendered] = rendered[#rendered] .. (index < #current and ',' or '')
        vim.list_extend(lines, rendered)
      end
      lines[#lines + 1] = prefix .. ']'
      return lines
    end

    local keys = {}
    for key in pairs(current) do
      keys[#keys + 1] = key
    end
    table.sort(keys, function(left, right)
      return tostring(left) < tostring(right)
    end)

    if #keys == 0 then
      return { prefix .. '{}' }
    end

    local lines = { prefix .. '{' }
    for index, key in ipairs(keys) do
      local rendered = render(current[key], depth + 1)
      local child_prefix = string.rep(' ', (depth + 1) * indent)
      rendered[1] = string.format(
        '%s%s: %s',
        child_prefix,
        encode_scalar(tostring(key)),
        rendered[1]:sub(#child_prefix + 1)
      )
      rendered[#rendered] = rendered[#rendered] .. (index < #keys and ',' or '')
      vim.list_extend(lines, rendered)
    end
    lines[#lines + 1] = prefix .. '}'
    return lines
  end

  return table.concat(render(value, 0), '\n')
end

--- One-line description of a StepErrorDto.
---@param err table|nil
---@return string|nil
function M.error_text(err)
  if type(err) ~= 'table' then
    return nil
  end

  local text = err.class or 'error'
  if type(err.message) == 'string' and err.message ~= '' then
    text = text .. ': ' .. err.message
  end
  if err.status then
    text = text .. string.format('  (HTTP %s)', tostring(err.status))
  end
  if err.stepKey then
    text = text .. '  [' .. err.stepKey .. ']'
  end
  return text
end

---@param workflow table
---@return string
function M.workflow_line(workflow)
  local parts = {
    string.format('%-34s', M.truncate(workflow.name or 'untitled', 34)),
    string.format('%-9s', workflow.status or 'unknown'),
    string.format('%-8s', workflow.triggerType or ''),
  }

  if workflow.stepCount then
    parts[#parts + 1] = string.format('%d steps', workflow.stepCount)
  end
  if workflow.lastRunAt then
    parts[#parts + 1] = string.format('last %s %s', workflow.lastRunStatus or 'run', M.relative_time(workflow.lastRunAt))
  else
    parts[#parts + 1] = 'never run'
  end

  return table.concat(parts, '  ')
end

---@param execution table
---@return string
function M.execution_line(execution)
  local parts = {
    (execution.id or ''):sub(1, 8),
    string.format('%-15s', execution.status or 'unknown'),
    string.format('%-30s', M.truncate(execution.workflowName or 'untitled', 30)),
  }

  parts[#parts + 1] = execution.isTest and 'test run' or (execution.triggerType or '')
  parts[#parts + 1] = M.relative_time(execution.startedAt or execution.createdAt)

  local duration = M.duration(execution.durationMs)
  if duration ~= '—' then
    parts[#parts + 1] = duration
  end

  return table.concat(parts, '  ·  ')
end

---@param workflow table
---@return string[] lines
---@return table[] highlights
function M.workflow_lines(workflow)
  local b = builder()

  local name = workflow.name or 'untitled'
  local status = workflow.status or 'unknown'
  local header = string.format('%s  [%s]', name, status)
  local row = b:add(header)
  b:span(row, 0, #name, 'S9Title')
  b:span(row, #name + 3, #header - 1, M.status_hl(status))

  b:blank()
  b:field('id', workflow.id or '')
  b:field('trigger', workflow.triggerType or 'unknown')

  local definition
  if present(workflow.draft) then
    definition = workflow.draft.definition
  elseif present(workflow.versions) and workflow.versions[1] then
    definition = workflow.versions[1].definition
  end

  local steps = present(definition) and definition.steps or {}
  b:field('steps', tostring(#steps))

  local version = workflow.currentVersionNumber and ('v' .. workflow.currentVersionNumber) or 'not published'
  if workflow.hasUnpublishedChanges then
    version = version .. '  ·  unpublished changes'
  end
  b:field('version', version, workflow.hasUnpublishedChanges and 'S9Warn' or nil)

  if present(workflow.webhookEndpoint) and type(workflow.webhookEndpoint.url) == 'string' then
    b:wrapped_field(
      'webhook',
      workflow.webhookEndpoint.url
        .. (workflow.webhookEndpoint.requireSignature and '  (signature required)' or '  (unsigned)'),
      nil,
      90
    )
  end

  if present(workflow.schedule) and type(workflow.schedule.scheduleSpec) == 'string' then
    b:field(
      'schedule',
      string.format(
        '%s %s  ·  %s',
        workflow.schedule.scheduleSpec,
        workflow.schedule.timezone,
        workflow.schedule.enabled and 'enabled' or 'disabled'
      ),
      workflow.schedule.enabled and 'S9Ok' or 'S9Muted'
    )
    if workflow.schedule.nextRunAt then
      b:field('next run', M.relative_time(workflow.schedule.nextRunAt))
    end
  end

  b:field('updated', M.relative_time(workflow.updatedAt))

  if type(workflow.description) == 'string' and vim.trim(workflow.description) ~= '' then
    b:wrapped_field('description', workflow.description, nil, 84)
  end

  if #steps > 0 then
    b:blank()
    b:line(b:add('steps'), 'S9Header')
    for index, step in ipairs(steps) do
      b:add(
        M.truncate(
          string.format('  %d. %-22s %-16s %s', index, step.key or '?', step.type or '?', step.name or ''),
          110
        )
      )
    end
  end

  return b.lines, b.highlights
end

---@param execution table
---@return string[] lines
---@return table[] highlights
function M.execution_lines(execution)
  local b = builder()

  local status = execution.status or 'unknown'
  local header = status
  if execution.isTest then
    header = header .. '  ·  test run'
  end
  if execution.workflowName and execution.workflowName ~= '' then
    header = header .. '  ·  ' .. execution.workflowName
  end
  if execution.triggerType then
    header = header .. '  ·  ' .. execution.triggerType
  end
  local row = b:add(header)
  b:span(row, 0, #status, M.status_hl(status))

  b:blank()
  b:field('id', execution.id or '')
  b:field(
    'version',
    execution.workflowVersionNumber and execution.workflowVersionNumber > 0
        and ('v' .. execution.workflowVersionNumber)
      or 'draft'
  )
  b:field('started', M.relative_time(execution.startedAt or execution.createdAt))
  if execution.finishedAt then
    b:field('finished', M.relative_time(execution.finishedAt))
  end
  b:field('duration', M.duration(execution.durationMs))
  if present(execution.rerunOfExecutionId) then
    b:field('rerun of', execution.rerunOfExecutionId)
  end

  local error_text = M.error_text(execution.error)
  if error_text then
    b:wrapped_field('error', error_text, 'S9Error', 90)
  end

  local steps = execution.steps or {}
  if #steps > 0 then
    b:blank()
    b:line(b:add('steps'), 'S9Header')
    for _, step in ipairs(steps) do
      local text = string.format(
        '%s %d. %-22s %-16s %-14s %s',
        M.step_icon(step.status),
        (step.stepIndex or 0) + 1,
        step.stepKey or '?',
        step.type or '?',
        step.status or '?',
        M.duration(step.durationMs)
      )
      if step.attemptCount and step.attemptCount > 1 then
        text = text .. string.format('  (%d attempts)', step.attemptCount)
      end
      if step.resolvedManually then
        text = text .. '  (resolved manually)'
      end
      local step_row = b:add(M.truncate(text, 118))
      b:span(step_row, 0, #M.step_icon(step.status), M.status_hl(step.status))

      local step_error = M.error_text(step.error)
      if step_error then
        b:wrapped_field('', step_error, 'S9Error', 100)
      end

      for _, attempt in ipairs(step.attempts or {}) do
        local attempt_text =
          string.format('attempt %d · %s · %s', attempt.attemptNumber or 0, attempt.status or '?', M.duration(attempt.durationMs))
        local attempt_error = M.error_text(attempt.error)
        if attempt_error then
          attempt_text = attempt_text .. ' · ' .. attempt_error
        end
        b:add('    ' .. M.truncate(attempt_text, 112))
      end
    end
  end

  if present(execution.timeline) and #execution.timeline > 0 then
    b:blank()
    b:line(b:add('timeline'), 'S9Header')
    local first = math.max(1, #execution.timeline - 19)
    for index = first, #execution.timeline do
      local event = execution.timeline[index]
      b:add(
        M.truncate(
          string.format('  %s  %s', M.clock_time(M.parse_iso(event.at)), event.message or ''),
          118
        )
      )
    end
  end

  b:blank()
  b:line(b:add('input'), 'S9Header')
  for _, line in ipairs(vim.split(M.pretty_json(present(execution.input) and execution.input or {}), '\n', { plain = true })) do
    b:add('  ' .. line)
  end

  if present(execution.output) then
    b:blank()
    b:line(b:add('output'), 'S9Header')
    for _, line in ipairs(vim.split(M.pretty_json(execution.output), '\n', { plain = true })) do
      b:add('  ' .. line)
    end
  end

  return b.lines, b.highlights
end

return M
