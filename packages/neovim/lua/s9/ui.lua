--- Presentation helpers: notifications, pickers, inputs and floating views.
---
--- The plugin deliberately depends on `vim.ui` instead of Telescope, so it
--- works on a stock Neovim and automatically uses Telescope, fzf-lua,
--- snacks.nvim or dressing.nvim when one of them is installed.
local M = {}

local namespace = vim.api.nvim_create_namespace('s9')

local groups = {
  S9Title = 'Title',
  S9Label = 'Comment',
  S9Header = 'Function',
  S9Ok = 'DiagnosticOk',
  S9Error = 'DiagnosticError',
  S9Warn = 'DiagnosticWarn',
  S9Busy = 'DiagnosticInfo',
  S9Muted = 'Comment',
  S9Key = 'Special',
}

for name, link in pairs(groups) do
  vim.api.nvim_set_hl(0, name, { link = link, default = true })
end

---@param message string
---@param level integer|nil
function M.notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = 's9' })
end

---@param err table|string
function M.error(err)
  if type(err) == 'string' then
    return M.notify(err, vim.log.levels.ERROR)
  end

  local parts = { err.message or 'the request failed' }
  if err.code then
    parts[#parts + 1] = string.format('(%s)', err.code)
  end
  if err.request_id then
    parts[#parts + 1] = string.format('request %s', err.request_id)
  end

  local message = table.concat(parts, ' ')
  if err.hint then
    message = message .. '\n' .. err.hint
  end

  M.notify(message, vim.log.levels.ERROR)
end

--- Wraps `vim.ui.select`. Does nothing when the list is empty.
---@param items table[]
---@param prompt string
---@param format_item fun(item: table): string
---@param on_choice fun(item: table)
function M.select(items, prompt, format_item, on_choice)
  if not items or #items == 0 then
    return M.notify('nothing to show')
  end

  vim.ui.select(items, {
    prompt = prompt,
    format_item = function(item)
      return format_item(item)
    end,
  }, function(choice)
    if choice ~= nil then
      on_choice(choice)
    end
  end)
end

--- Wraps `vim.ui.input`; cancelling does nothing.
---@param opts table
---@param on_submit fun(value: string)
function M.input(opts, on_submit)
  vim.ui.input(opts, function(value)
    if value ~= nil then
      on_submit(value)
    end
  end)
end

---@param question string
---@param on_confirm fun()
function M.confirm(question, on_confirm)
  if vim.fn.confirm(question, '&Yes\n&No', 2, 'Question') == 1 then
    on_confirm()
  end
end

local function dimension(value, total, minimum, maximum)
  if type(value) ~= 'number' or value <= 0 then
    value = 0.8
  end
  local size = value <= 1 and math.floor(total * value) or math.floor(value)
  return math.max(minimum, math.min(size, maximum))
end

--- Opens a scratch floating window.
---
--- @param opts table
---   lines       string[]
---   highlights  table[]|nil
---   filetype    string|nil
---   title       string|nil
---   footer      string|nil
---   keys        table[]|nil   { lhs, description, function(view) }
--- @return table view  { win, buf, render(lines, highlights), close() }
function M.open(opts)
  local config = require('s9.config').get()

  local width = dimension(opts.width or config.width, vim.o.columns, 40, math.max(40, vim.o.columns - 4))
  local height = dimension(opts.height or config.height, vim.o.lines - 1, 5, math.max(5, vim.o.lines - 6))
  local row = math.max(0, math.floor((vim.o.lines - height) / 2) - 1)
  local col = math.max(0, math.floor((vim.o.columns - width) / 2))

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  if opts.filetype then
    vim.bo[buf].filetype = opts.filetype
  end

  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    style = 'minimal',
    border = config.border,
    width = width,
    height = height,
    row = row,
    col = col,
    title = opts.title,
    title_pos = opts.title and 'center' or nil,
    footer = opts.footer,
    footer_pos = opts.footer and 'center' or nil,
  })

  vim.wo[win].wrap = false
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
  vim.wo[win].signcolumn = 'no'
  vim.wo[win].foldcolumn = '0'
  vim.wo[win].cursorline = false
  vim.wo[win].winhighlight = 'NormalFloat:NormalFloat,FloatBorder:FloatBorder'

  local view = { win = win, buf = buf }

  function view.close()
    if vim.api.nvim_win_is_valid(win) then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end

  function view.render(lines, highlights)
    if not vim.api.nvim_buf_is_valid(buf) then
      return
    end

    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_clear_namespace(buf, namespace, 0, -1)

    for _, spec in ipairs(highlights or {}) do
      if spec.row >= 1 and spec.row <= #lines then
        if spec.line then
          vim.api.nvim_buf_set_extmark(buf, namespace, spec.row - 1, 0, {
            line_hl_group = spec.hl,
          })
        else
          pcall(vim.api.nvim_buf_set_extmark, buf, namespace, spec.row - 1, spec.col or 0, {
            end_col = spec.end_col,
            hl_group = spec.hl,
          })
        end
      end
    end
  end

  view.render(opts.lines or { '' }, opts.highlights)

  local keymaps = {
    { 'q', 'close', function()
      view.close()
    end },
    { '<Esc>', 'close', function()
      view.close()
    end },
  }
  vim.list_extend(keymaps, opts.keys or {})

  for _, key in ipairs(keymaps) do
    vim.keymap.set('n', key[1], function()
      key[3](view)
    end, {
      buffer = buf,
      nowait = true,
      silent = true,
      desc = 's9: ' .. (key[2] or key[1]),
    })
  end

  return view
end

--- Opens a URL in the browser.
---@param path string path on the web app, starting with a slash
function M.open_url(path)
  local config = require('s9.config').get()
  local url = config.web_url .. path

  local command = config.open_cmd
  if command == nil then
    local binary = 'xdg-open'
    if vim.fn.has('mac') == 1 then
      binary = 'open'
    elseif vim.fn.has('win32') == 1 then
      binary = 'explorer'
    end
    command = { binary }
  end

  if vim.fn.executable(command[1]) ~= 1 then
    return M.notify('cannot open a browser: ' .. command[1] .. ' is not installed', vim.log.levels.WARN)
  end

  local argv = vim.deepcopy(command)
  argv[#argv + 1] = url

  local job = vim.fn.jobstart(argv, { detach = true })
  if job <= 0 then
    M.notify('could not open ' .. url, vim.log.levels.WARN)
  end
end

--- Formats the hint line shown in the footer of a view.
---@param keys table[] { lhs, description }
---@return string|nil
function M.footer(keys)
  local parts = {}
  for _, key in ipairs(keys or {}) do
    parts[#parts + 1] = string.format('%s %s', key[1], key[2])
  end
  if #parts == 0 then
    return nil
  end
  return table.concat(parts, '  ·  ')
end

return M
