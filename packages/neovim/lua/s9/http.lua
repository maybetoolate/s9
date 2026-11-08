--- A small asynchronous HTTP client.
---
--- Neovim has no socket API, so the plugin shells out to `curl`. The process
--- is asynchronous: the editor never blocks while a request is in flight.
local M = {}

local function read_file(path)
  local file = io.open(path, 'rb')
  if not file then
    return ''
  end
  local data = file:read('*a') or ''
  file:close()
  return data
end

--- Creates a temp file that only the current user can read.
---
--- `vim.fn.tempname()` only reserves a name; the file itself has to be
--- created with restrictive permissions, otherwise a response body that
--- contains workflow data would be readable by every local user while the
--- request is in flight.
---@param path string
---@param contents string|nil
---@return boolean
local function write_private_file(path, contents)
  local fd = vim.uv.fs_open(path, 'w', 384) -- 0600
  if not fd then
    return false
  end
  if contents then
    vim.uv.fs_write(fd, contents, 0)
  end
  vim.uv.fs_close(fd)
  return true
end

local function normalize_null(value)
  if value == vim.NIL then
    return nil
  end
  if type(value) == 'table' then
    for key, item in pairs(value) do
      value[key] = normalize_null(item)
    end
  end
  return value
end

--- Decodes JSON, turning `null` into Lua `nil` where the runtime supports it.
---
--- The API returns `null` for optional fields (a draft, a schedule, an
--- execution output). Left as `vim.NIL` those values are truthy in Lua and
--- blow up the first time a renderer indexes them.
---@param text string
---@return any|nil
function M.decode_json(text)
  if text == '' then
    return nil
  end

  local ok, decoded = pcall(vim.json.decode, text, { luanil = { object = true, array = true } })
  if ok then
    return decoded
  end

  local fallback_ok, fallback = pcall(vim.json.decode, text)
  if not fallback_ok then
    return nil
  end
  return normalize_null(fallback)
end

--- Parses a curl header dump plus the response body.
---@param header_text string
---@param body_text string
---@return table result
function M.parse_response(header_text, body_text)
  local result = {
    status = 0,
    headers = {},
    set_cookies = {},
    body = body_text or '',
  }

  for line in (header_text or ''):gmatch('[^\r\n]+') do
    local status = line:match('^HTTP/%d+%.%d+%s+(%d%d%d)')
    if status then
      -- A new response block; anything before it belongs to a redirect or a
      -- 100-continue handshake that the caller does not care about.
      result.status = tonumber(status)
      result.headers = {}
      result.set_cookies = {}
    else
      local name, value = line:match('^([%w%-_]+):%s*(.*)$')
      if name then
        name = name:lower()
        result.headers[name] = result.headers[name] or {}
        table.insert(result.headers[name], value)
        if name == 'set-cookie' then
          result.set_cookies[#result.set_cookies + 1] = value
        end
      end
    end
  end

  local request_id = result.headers['x-request-id']
  result.request_id = request_id and request_id[1] or nil

  result.json = M.decode_json(result.body)

  return result
end

local function transport_error(code, stderr, url)
  local message = stderr ~= '' and stderr or string.format('curl exited with code %d', code)
  local origin = url:match('^(https?://[^/]+)')
  if code == 7 then
    message = string.format('%s — is the s9 API running at %s?', message, origin or url)
  elseif code == 28 then
    message = 'the request timed out'
  end
  return { error = true, message = message }
end

--- Performs an HTTP request.
---
--- @param opts table
---   method     string        HTTP method, defaults to GET
---   url        string
---   headers    table|nil     name -> value
---   body       string|nil    raw request body
---   timeout_ms integer|nil
--- @param callback fun(result: table) called on the main loop
function M.request(opts, callback)
  if vim.fn.executable('curl') ~= 1 then
    callback({ error = true, message = 's9 needs curl, but it is not on PATH' })
    return
  end

  local config = require('s9.config').get()
  local timeout_ms = opts.timeout_ms or config.timeout_ms
  local request_header_path = vim.fn.tempname()
  local response_header_path = vim.fn.tempname()
  local body_path = vim.fn.tempname()

  local header_lines = {}
  for name, value in pairs(opts.headers or {}) do
    header_lines[#header_lines + 1] = string.format('%s: %s', name, value)
  end
  table.sort(header_lines)

  -- The cookie must not appear in argv: /proc/<pid>/cmdline is readable by
  -- every local user while curl runs.
  if not write_private_file(request_header_path, table.concat(header_lines, '\n') .. '\n') then
    callback({ error = true, message = 'could not write the request headers to a temporary file' })
    return
  end

  -- Pre-create the response files so curl truncates a 0600 file instead of
  -- creating a world-readable one.
  if not write_private_file(response_header_path) or not write_private_file(body_path) then
    os.remove(request_header_path)
    os.remove(response_header_path)
    os.remove(body_path)
    callback({ error = true, message = 'could not create a temporary file for the response' })
    return
  end

  local command = {
    'curl',
    '--silent',
    '--show-error',
    '--no-progress-meter',
    '--max-time',
    string.format('%.1f', timeout_ms / 1000),
    '--request',
    (opts.method or 'GET'):upper(),
    '--header',
    '@' .. request_header_path,
    '--dump-header',
    response_header_path,
    '--output',
    body_path,
    '--write-out',
    '%{http_code}',
  }

  if opts.body ~= nil then
    command[#command + 1] = '--data-binary'
    command[#command + 1] = '@-'
  end

  command[#command + 1] = opts.url

  local finished = false
  local function finish(result)
    if finished then
      return
    end
    finished = true
    vim.schedule(function()
      os.remove(request_header_path)
      os.remove(response_header_path)
      os.remove(body_path)
      callback(result)
    end)
  end

  local ok, err = pcall(vim.system, command, {
    stdin = opts.body,
    timeout = timeout_ms + 5000,
  }, function(process)
    local header_text = read_file(response_header_path)
    local body_text = read_file(body_path)
    local code = process.code or 0
    local stderr = vim.trim(process.stderr or '')

    if code ~= 0 then
      finish(transport_error(code, stderr, opts.url))
      return
    end

    local result = M.parse_response(header_text, body_text)
    if result.status == 0 then
      finish(transport_error(code, stderr, opts.url))
      return
    end

    finish(result)
  end)

  if not ok then
    finish({ error = true, message = 'could not start curl: ' .. tostring(err) })
  end
end

return M
