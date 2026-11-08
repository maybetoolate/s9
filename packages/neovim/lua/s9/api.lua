--- Thin, typed-ish wrapper around the s9 REST API.
---
--- Every function takes a node-style callback: `callback(err, data, response)`.
--- `err` is a table (`message`, `status`, `code`, `details`, `request_id`,
--- `hint`) rather than a string so the UI can show the machine-readable code
--- and the request id that support needs.
local http = require('s9.http')
local session = require('s9.session')

local M = {}

--- Neovim encodes an empty Lua table as `[]`; the API expects an object.
---@param value any
---@return any
local function record(value)
  if type(value) == 'table' and next(value) == nil then
    return vim.empty_dict()
  end
  return value
end

--- RFC 3986 percent encoding. `vim.uri_encode` leaves sub-delimiters alone,
--- which is fine for paths but ambiguous inside a query value.
---@param value string
---@return string
function M.url_encode(value)
  return (tostring(value):gsub('[^%w%-%._~]', function(char)
    return string.format('%%%02X', string.byte(char))
  end))
end

--- Builds a deterministic query string, skipping empty values.
---@param query table<string, string|number|boolean|nil>
---@return string
function M.encode_query(query)
  local parts = {}
  for key, value in pairs(query or {}) do
    if value ~= nil and value ~= '' then
      parts[#parts + 1] = M.url_encode(key) .. '=' .. M.url_encode(value)
    end
  end
  table.sort(parts)
  return table.concat(parts, '&')
end

--- Normalizes the two error envelopes the API uses: s9's
--- `{ error: { code, message, requestId } }` and Better-Auth's flat
--- `{ code, message }`.
---@param status integer
---@param body table|nil
---@param request_id string|nil
---@return table error
function M.parse_error(status, body, request_id)
  local code, message, details

  if type(body) == 'table' then
    if type(body.error) == 'table' then
      code = body.error.code
      message = body.error.message
      details = body.error.details
      request_id = body.error.requestId or request_id
    else
      code = body.code
      message = body.message
    end
  end

  if type(message) ~= 'string' or message == '' then
    message = status > 0 and string.format('the API returned HTTP %d', status) or 'the request failed'
  end

  local err = {
    status = status,
    code = code,
    message = message,
    details = details,
    request_id = request_id,
  }

  if status == 401 then
    err.hint = 'the session is missing or expired; run :S9 login'
  end

  return err
end

---@param method string
---@param path string
---@param opts table|nil
---@param callback fun(err: table|nil, data: any, response: table|nil)
function M.request(method, path, opts, callback)
  opts = opts or {}
  session.load()

  local config = require('s9.config').get()
  local url = config.base_url .. path
  local query = M.encode_query(opts.query)
  if query ~= '' then
    url = url .. '?' .. query
  end

  local headers = {
    accept = 'application/json',
    -- Better-Auth validates the Origin of every cookie-authenticated write.
    -- A native client has no browser origin, so it sends the web app origin
    -- the API was configured with.
    origin = config.web_url,
  }

  local method_upper = method:upper()
  local expects_body = method_upper == 'POST' or method_upper == 'PUT' or method_upper == 'PATCH'

  local body = opts.body
  if body == nil and expects_body then
    body = vim.empty_dict()
  end

  local payload = nil
  if body ~= nil then
    headers['content-type'] = 'application/json'
    local ok, encoded = pcall(vim.json.encode, body)
    if not ok then
      callback({ message = 'could not encode the request body: ' .. tostring(encoded) })
      return
    end
    payload = encoded
  end

  local cookie = session.cookie_header()
  if cookie then
    headers.cookie = cookie
  end

  http.request({
    method = method,
    url = url,
    headers = headers,
    body = payload,
    timeout_ms = opts.timeout_ms,
  }, function(response)
    if response.error then
      callback({ message = response.message })
      return
    end

    if response.status >= 200 and response.status < 300 then
      callback(nil, response.json, response)
      return
    end

    callback(M.parse_error(response.status, response.json, response.request_id), response.json, response)
  end)
end

--- Signs in and stores the session cookie.
---@param email string
---@param password string
---@param callback fun(err: table|nil, me: table|nil)
function M.login(email, password, callback)
  M.request('POST', '/api/auth/sign-in/email', {
    body = { email = email, password = password },
  }, function(err, _, response)
    if err then
      return callback(err)
    end

    local cookies = response and response.set_cookies or {}
    if session.parse_set_cookie(cookies)[1] == nil then
      return callback({ message = 'sign-in succeeded but the API returned no session cookie' })
    end

    local stored, store_err = session.store(cookies)
    if not stored then
      return callback({ message = 'signed in, but the session could not be stored: ' .. tostring(store_err) })
    end

    M.me(function(me_err, me)
      if me_err then
        return callback(me_err)
      end
      session.identify(me)
      callback(nil, me)
    end)
  end)
end

--- Ends the session on the server and locally.
---@param callback fun(err: table|nil)
function M.logout(callback)
  M.request('POST', '/api/auth/sign-out', {}, function(err)
    session.clear()
    callback(err)
  end)
end

---@param callback fun(err: table|nil, me: table|nil)
function M.me(callback)
  M.request('GET', '/api/me', {}, callback)
end

---@param opts table|nil
---@param callback fun(err: table|nil, page: table|nil)
function M.workflows(opts, callback)
  opts = opts or {}
  M.request('GET', '/api/workflows', {
    query = {
      page = opts.page or 1,
      pageSize = opts.page_size or require('s9.config').get().page_size,
      search = opts.search,
      status = opts.status,
      triggerType = opts.trigger,
    },
  }, callback)
end

---@param id string
---@param callback fun(err: table|nil, workflow: table|nil)
function M.workflow(id, callback)
  M.request('GET', '/api/workflows/' .. M.url_encode(id), {}, callback)
end

---@param id string
---@param callback fun(err: table|nil, versions: table[]|nil)
function M.versions(id, callback)
  M.request('GET', '/api/workflows/' .. M.url_encode(id) .. '/versions', {}, function(err, data)
    if err then
      return callback(err)
    end
    callback(nil, type(data) == 'table' and data.data or {})
  end)
end

--- Starts a production run. Requires a published workflow.
---@param id string
---@param input table
---@param callback fun(err: table|nil, result: table|nil)
function M.run(id, input, callback)
  M.request('POST', '/api/workflows/' .. M.url_encode(id) .. '/run', { body = { input = record(input) } }, callback)
end

--- Starts a test run against the draft. Side effects are simulated.
---@param id string
---@param input table
---@param callback fun(err: table|nil, result: table|nil)
function M.test(id, input, callback)
  M.request('POST', '/api/workflows/' .. M.url_encode(id) .. '/test', { body = { input = record(input) } }, callback)
end

---@param id string
---@param action 'pause'|'resume'
---@param callback fun(err: table|nil, result: table|nil)
function M.lifecycle(id, action, callback)
  M.request('POST', '/api/workflows/' .. M.url_encode(id) .. '/' .. action, {}, callback)
end

---@param opts table|nil
---@param callback fun(err: table|nil, page: table|nil)
function M.executions(opts, callback)
  opts = opts or {}
  M.request('GET', '/api/executions', {
    query = {
      page = opts.page or 1,
      pageSize = opts.page_size or require('s9.config').get().page_size,
      workflowId = opts.workflow_id,
      status = opts.status,
      triggerType = opts.trigger,
      isTest = opts.is_test,
      search = opts.search,
    },
  }, callback)
end

---@param id string
---@param callback fun(err: table|nil, execution: table|nil)
function M.execution(id, callback)
  M.request('GET', '/api/executions/' .. M.url_encode(id), {}, callback)
end

--- Retries one failed step in place. Successful steps are not repeated.
---@param id string
---@param step_key string
---@param callback fun(err: table|nil, result: table|nil)
function M.retry(id, step_key, callback)
  local idempotency_key = string.format('retry:%s:%s:%d', id, step_key, vim.uv.hrtime())
  M.request('POST', '/api/executions/' .. M.url_encode(id) .. '/retry', {
    body = { stepKey = step_key, idempotencyKey = idempotency_key },
  }, callback)
end

--- Reruns a whole execution. Every step runs again, including the ones that
--- already succeeded.
---@param id string
---@param opts table|nil
---@param callback fun(err: table|nil, result: table|nil)
function M.rerun(id, opts, callback)
  opts = opts or {}
  M.request('POST', '/api/executions/' .. M.url_encode(id) .. '/rerun', {
    body = { useCurrentVersion = opts.use_current_version == true, input = opts.input and record(opts.input) or nil },
  }, callback)
end

---@param id string
---@param callback fun(err: table|nil, result: table|nil)
function M.cancel(id, callback)
  M.request('POST', '/api/executions/' .. M.url_encode(id) .. '/cancel', {}, callback)
end

--- Resolves a step whose outcome is unknown.
---@param id string
---@param step_key string
---@param outcome 'succeeded'|'failed'
---@param reason string
---@param callback fun(err: table|nil, result: table|nil)
function M.resolve(id, step_key, outcome, reason, callback)
  M.request(
    'POST',
    string.format('/api/executions/%s/steps/%s/resolve', M.url_encode(id), M.url_encode(step_key)),
    { body = { outcome = outcome, reason = reason } },
    callback
  )
end

---@param callback fun(err: table|nil, dashboard: table|nil)
function M.dashboard(callback)
  M.request('GET', '/api/dashboard', {}, callback)
end

return M
