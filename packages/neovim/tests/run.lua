-- Headless tests for s9.nvim.
--
--   nvim --headless -u NONE -l tests/run.lua
--
-- They exercise the pure modules (formatting, query building, error
-- normalization, cookie parsing) and the rendering functions. The HTTP client
-- and the API are covered with a stubbed transport; the integration suite in
-- packages/server covers the real endpoints.
local script = debug.getinfo(1, 'S').source:sub(2)
local root = vim.fn.fnamemodify(script, ':h:h')

package.path = table.concat({
  root .. '/lua/?.lua',
  root .. '/lua/?/init.lua',
  package.path,
}, ';')

local failures = 0
local total = 0

local function test(name, fn)
  total = total + 1
  local ok, err = pcall(fn)
  if ok then
    io.write('ok   ' .. name .. '\n')
  else
    failures = failures + 1
    io.write('FAIL ' .. name .. '\n     ' .. tostring(err) .. '\n')
  end
end

local function assert_true(value, message)
  if not value then
    error(message or 'expected a truthy value', 2)
  end
end

local function assert_equal(actual, expected, message)
  if not vim.deep_equal(actual, expected) then
    error(
      string.format('%s: expected %s, got %s', message or 'value', vim.inspect(expected), vim.inspect(actual)),
      2
    )
  end
end

local function assert_contains(haystack, needle, message)
  if not tostring(haystack):find(needle, 1, true) then
    error(string.format('%s: %s does not contain %s', message or 'value', vim.inspect(haystack), vim.inspect(needle)), 2)
  end
end

local config = require('s9.config')
local session = require('s9.session')
local http = require('s9.http')
local api = require('s9.api')
local format = require('s9.format')

test('config applies defaults and normalizes URLs', function()
  config.reset()
  local options = config.setup({ base_url = 'http://localhost:4100///', web_url = 'http://localhost:3000/' })
  assert_equal(options.base_url, 'http://localhost:4100')
  assert_equal(options.web_url, 'http://localhost:3000')
  assert_equal(options.poll_interval_ms, 2000)
  config.reset()
end)

test('config clamps unsafe values', function()
  config.reset()
  local options = config.setup({ timeout_ms = 10, poll_interval_ms = 1, page_size = 1000 })
  assert_equal(options.timeout_ms, 1000)
  assert_equal(options.poll_interval_ms, 250)
  assert_equal(options.page_size, 100)
  config.reset()
end)

test('config rejects an empty base_url', function()
  local ok = pcall(config.setup, { base_url = '' })
  assert_true(not ok, 'setup should reject an empty base_url')
  config.reset()
end)

test('parse_set_cookie keeps s9 cookies and ignores the rest', function()
  local cookies = session.parse_set_cookie({
    'other=1; Path=/',
    's9.session_token=abc123; Path=/; HttpOnly; SameSite=Lax',
    's9.session_data=xyz; Path=/; HttpOnly',
    '__Secure-s9.session_token.0=chunk; Path=/; Secure',
  })

  assert_equal(cookies, {
    's9.session_token=abc123',
    's9.session_data=xyz',
    '__Secure-s9.session_token.0=chunk',
  })
end)

test('parse_set_cookie rejects malformed values', function()
  assert_equal(session.parse_set_cookie({ 's9.session_token', '=nope' }), {})
  assert_equal(session.parse_set_cookie(nil), {})
end)

test('parse_response reads status, headers, cookies and JSON', function()
  local header_text = table.concat({
    'HTTP/1.1 202 Accepted',
    'content-type: application/json',
    'set-cookie: s9.session_token=abc; Path=/; HttpOnly',
    'x-request-id: req-1',
    '',
  }, '\r\n')

  local response = http.parse_response(header_text, '{"ok":true}')

  assert_equal(response.status, 202)
  assert_equal(response.json, { ok = true })
  assert_equal(response.request_id, 'req-1')
  assert_equal(response.set_cookies, { 's9.session_token=abc; Path=/; HttpOnly' })
end)

test('parse_response keeps the last block of a redirect chain', function()
  local header_text = table.concat({
    'HTTP/1.1 100 Continue',
    '',
    'HTTP/1.1 200 OK',
    'content-type: application/json',
    '',
  }, '\r\n')

  local response = http.parse_response(header_text, 'not json')
  assert_equal(response.status, 200)
  assert_equal(response.json, nil)
  assert_equal(response.body, 'not json')
end)

test('url_encode encodes path and query separators', function()
  assert_equal(api.url_encode('a b/c&d?e=f'), 'a%20b%2Fc%26d%3Fe%3Df')
end)

test('encode_query is sorted, encoded and skips empty values', function()
  local query = api.encode_query({
    workflowId = 'wf 1',
    status = 'failed',
    search = nil,
    isTest = false,
    page = 2,
  })

  assert_equal(query, 'isTest=false&page=2&status=failed&workflowId=wf%201')
end)

test('parse_error understands the s9 envelope', function()
  local err = api.parse_error(409, {
    error = { code = 'no_published_version', message = 'the workflow has no published version', requestId = 'req-9' },
  })

  assert_equal(err.status, 409)
  assert_equal(err.code, 'no_published_version')
  assert_equal(err.message, 'the workflow has no published version')
  assert_equal(err.request_id, 'req-9')
  assert_equal(err.hint, nil)
end)

test('parse_error understands the Better-Auth flat envelope', function()
  local err = api.parse_error(401, { code = 'INVALID_EMAIL_OR_PASSWORD', message = 'Invalid email or password' })

  assert_equal(err.code, 'INVALID_EMAIL_OR_PASSWORD')
  assert_equal(err.message, 'Invalid email or password')
  assert_contains(err.hint, ':S9 login')
end)

test('parse_error falls back to the status code', function()
  local err = api.parse_error(500, 'not json', 'req-2')
  assert_equal(err.message, 'the API returned HTTP 500')
  assert_equal(err.request_id, 'req-2')
end)

test('parse_iso converts UTC and offsets to the same epoch', function()
  local utc = format.parse_iso('2026-10-20T12:00:00.000Z')
  local offset = format.parse_iso('2026-10-20T14:00:00+02:00')

  assert_true(utc ~= nil, 'the UTC timestamp did not parse')
  assert_equal(utc, offset)
  assert_equal(os.date('!%Y-%m-%dT%H:%M:%SZ', utc), '2026-10-20T12:00:00Z')
  assert_equal(format.parse_iso('nope'), nil)
  assert_equal(format.parse_iso(nil), nil)
end)

test('relative_time is stable', function()
  local now = format.parse_iso('2026-10-20T12:00:00Z')
  assert_equal(format.relative_time('2026-10-20T11:59:30Z', now), '30s ago')
  assert_equal(format.relative_time('2026-10-20T11:58:00Z', now), '2m ago')
  assert_equal(format.relative_time('2026-10-20T09:00:00Z', now), '3h ago')
  assert_equal(format.relative_time('2026-10-18T12:00:00Z', now), '2d ago')
  assert_equal(format.relative_time(nil, now), '—')
end)

test('duration formats milliseconds, seconds, minutes and hours', function()
  assert_equal(format.duration(nil), '—')
  assert_equal(format.duration(250), '250ms')
  assert_equal(format.duration(1500), '1.5s')
  assert_equal(format.duration(125000), '2m 05s')
  assert_equal(format.duration(3 * 3600 * 1000 + 5 * 60 * 1000), '3h 05m')
end)

test('truncate collapses whitespace and respects the character limit', function()
  assert_equal(format.truncate('  hello \n world  ', 20), 'hello world')
  assert_equal(format.truncate('hello world', 8), 'hello w…')
  assert_equal(format.truncate('héllo wörld', 6), 'héllo…')
end)

test('wrap keeps words intact', function()
  assert_equal(format.wrap('one two three four', 9), { 'one two', 'three', 'four' })
  assert_equal(format.wrap('', 10), { '' })
end)

test('pretty_json sorts keys and renders nested values', function()
  local decoded = vim.json.decode('{"b":[1,2],"a":{"c":null,"d":"x"}}')
  assert_equal(format.pretty_json(decoded), table.concat({
    '{',
    '  "a": {',
    '    "c": null,',
    '    "d": "x"',
    '  },',
    '  "b": [',
    '    1,',
    '    2',
    '  ]',
    '}',
  }, '\n'))
end)

test('status_hl maps every execution status', function()
  for _, status in ipairs({ 'queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled' }) do
    assert_true(format.status_hl(status):find('S9') == 1, 'missing highlight for ' .. status)
  end
  assert_equal(format.status_hl('unknown'), 'S9Muted')
end)

local function assert_highlights_fit(lines, highlights)
  for _, spec in ipairs(highlights) do
    assert_true(spec.row >= 1 and spec.row <= #lines, 'highlight row out of range: ' .. tostring(spec.row))
    if not spec.line then
      assert_true(spec.end_col <= #lines[spec.row], 'highlight column out of range on row ' .. spec.row)
    end
  end
end

test('workflow_lines renders the detail fields', function()
  local lines, highlights = format.workflow_lines({
    id = 'wf-1',
    name = 'Contact form follow-up',
    status = 'published',
    triggerType = 'webhook',
    currentVersionNumber = 2,
    hasUnpublishedChanges = true,
    description = 'Saves a contact, sends a confirmation email and notifies sales.',
    draft = {
      definition = {
        steps = {
          { key = 'save_contact', type = 'database_insert', name = 'Save contact' },
          { key = 'send_email', type = 'send_email', name = 'Send confirmation' },
        },
      },
    },
    webhookEndpoint = { url = 'http://localhost:4100/webhooks/abc', requireSignature = true },
    schedule = nil,
    updatedAt = '2026-10-20T12:00:00Z',
  })

  local text = table.concat(lines, '\n')
  assert_contains(text, 'Contact form follow-up  [published]')
  assert_contains(text, 'unpublished changes')
  assert_contains(text, 'webhooks/abc')
  assert_contains(text, 'save_contact')
  assert_highlights_fit(lines, highlights)
end)

test('execution_lines renders steps, attempts and the error', function()
  local lines, highlights = format.execution_lines({
    id = 'exec-12345678',
    workflowName = 'Contact form follow-up',
    workflowVersionNumber = 2,
    status = 'failed',
    triggerType = 'manual',
    isTest = false,
    startedAt = '2026-10-20T11:59:00Z',
    finishedAt = '2026-10-20T11:59:02Z',
    durationMs = 2000,
    input = { email = 'ada@example.com' },
    error = { class = 'permanent', message = 'the provider rejected the request', stepKey = 'send_email' },
    steps = {
      {
        stepKey = 'save_contact',
        stepIndex = 0,
        name = 'Save contact',
        type = 'database_insert',
        status = 'succeeded',
        durationMs = 120,
        attemptCount = 1,
        attempts = {
          { attemptNumber = 1, status = 'succeeded', durationMs = 120 },
        },
      },
      {
        stepKey = 'send_email',
        stepIndex = 1,
        name = 'Send confirmation',
        type = 'send_email',
        status = 'failed',
        durationMs = 1500,
        attemptCount = 2,
        safeToRepeat = false,
        error = { class = 'permanent', message = 'provider returned 422' },
        attempts = {
          { attemptNumber = 1, status = 'failed', durationMs = 700, error = { class = 'transient', message = 'timeout' } },
          { attemptNumber = 2, status = 'failed', durationMs = 800, error = { class = 'permanent', message = '422' } },
        },
      },
    },
    timeline = {
      { at = '2026-10-20T11:59:00Z', message = 'the execution was created by the manual trigger', status = 'queued' },
      { at = '2026-10-20T11:59:02Z', message = 'step "send_email" failed', status = 'failed' },
    },
  })

  local text = table.concat(lines, '\n')
  assert_contains(text, 'failed  ·  Contact form follow-up  ·  manual')
  assert_contains(text, '✓ 1. save_contact')
  assert_contains(text, '✗ 2. send_email')
  assert_contains(text, '(2 attempts)')
  assert_contains(text, 'attempt 1 · failed')
  assert_contains(text, 'provider returned 422')
  assert_contains(text, 'ada@example.com')
  assert_highlights_fit(lines, highlights)
end)

test('decode_json keeps parenthesized nulls out of the renderers', function()
  local decoded = http.decode_json('{"draft":null,"schedule":null,"ok":1}')
  assert_equal(decoded.draft, nil)
  assert_equal(decoded.schedule, nil)
  assert_equal(decoded.ok, 1)
end)

test('workflow_lines renders a workflow with null optional fields', function()
  local decoded = http.decode_json(table.concat({
    '{"id":"wf-1","name":"Draft only","status":"draft","triggerType":"manual",',
    '"currentVersionNumber":null,"hasUnpublishedChanges":false,"description":null,',
    '"draft":{"definition":{"steps":[]}},"versions":[],"webhookEndpoint":null,"schedule":null,',
    '"updatedAt":"2026-10-20T12:00:00Z"}',
  }))

  local lines = format.workflow_lines(decoded)
  assert_contains(table.concat(lines, '\n'), 'Draft only  [draft]')
end)

test('execution_lines renders an execution with a null output', function()
  local decoded = http.decode_json(table.concat({
    '{"id":"exec-1","workflowName":"Draft only","workflowVersionNumber":0,"status":"succeeded",',
    '"triggerType":"manual","isTest":true,"durationMs":100,"input":null,"output":null,',
    '"error":null,"steps":[],"timeline":[],"createdAt":"2026-10-20T12:00:00Z","startedAt":null}',
  }))

  local lines = format.execution_lines(decoded)
  assert_contains(table.concat(lines, '\n'), 'succeeded  ·  test run  ·  Draft only')
end)

test('api forwards the query through the transport', function()
  local original_http = package.loaded['s9.http']
  local captured
  package.loaded['s9.http'] = {
    request = function(opts, callback)
      captured = opts
      callback({
        status = 200,
        json = { data = { { id = 'exec-1' } }, pagination = { total = 1 } },
        headers = {},
        set_cookies = {},
        body = '',
      })
    end,
  }
  package.loaded['s9.api'] = nil

  local stub_api = require('s9.api')
  local received
  stub_api.executions({ workflow_id = 'wf 1', status = 'failed' }, function(err, page)
    assert_equal(err, nil)
    received = page
  end)

  assert_contains(captured.url, '/api/executions?')
  assert_contains(captured.url, 'workflowId=wf%201')
  assert_contains(captured.url, 'status=failed')
  assert_equal(received.data[1].id, 'exec-1')

  package.loaded['s9.http'] = original_http
  package.loaded['s9.api'] = nil
end)

test('api sends an Origin header and an empty object for a bodyless POST', function()
  local original_http = package.loaded['s9.http']
  local captured
  package.loaded['s9.http'] = {
    request = function(opts, callback)
      captured = opts
      callback({ status = 200, json = {}, headers = {}, set_cookies = {}, body = '' })
    end,
  }
  package.loaded['s9.api'] = nil

  local stub_api = require('s9.api')
  stub_api.cancel('exec-1', function() end)

  assert_equal(captured.method, 'POST')
  assert_equal(captured.headers.origin, require('s9.config').get().web_url)
  assert_equal(captured.headers['content-type'], 'application/json')
  assert_equal(captured.body, '{}')

  package.loaded['s9.http'] = original_http
  package.loaded['s9.api'] = nil
end)

test('api encodes an empty run input as an object', function()
  local original_http = package.loaded['s9.http']
  local captured
  package.loaded['s9.http'] = {
    request = function(opts, callback)
      captured = opts
      callback({ status = 202, json = { executionId = 'exec-1' }, headers = {}, set_cookies = {}, body = '' })
    end,
  }
  package.loaded['s9.api'] = nil

  local stub_api = require('s9.api')
  stub_api.test('wf-1', {}, function() end)

  assert_equal(captured.body, '{"input":{}}')

  package.loaded['s9.http'] = original_http
  package.loaded['s9.api'] = nil
end)

test('api turns a transport failure into an error table', function()
  local original_http = package.loaded['s9.http']
  package.loaded['s9.http'] = {
    request = function(_, callback)
      callback({ error = true, message = 'connection refused' })
    end,
  }
  package.loaded['s9.api'] = nil

  local stub_api = require('s9.api')
  local received
  stub_api.me(function(err)
    received = err
  end)

  assert_equal(received.message, 'connection refused')

  package.loaded['s9.http'] = original_http
  package.loaded['s9.api'] = nil
end)

test('the plugin loads its user command', function()
  dofile(root .. '/plugin/s9.lua')
  local commands = vim.api.nvim_get_commands({})
  assert_true(commands.S9 ~= nil, 'the s9 command is not registered')
  assert_equal(require('s9').complete()[1], 'login')
end)

config.reset()

io.write(string.format('\n%d tests, %d failures\n', total, failures))
if failures > 0 then
  os.exit(1)
end
