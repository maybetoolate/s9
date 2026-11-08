--- `:checkhealth s9` entry point.
local M = {}

local function health_api()
  return vim.health or require('health')
end

local function probe(url)
  local ok, process = pcall(vim.system, {
    'curl',
    '--silent',
    '--show-error',
    '--fail',
    '--max-time',
    '2',
    url,
  }, { text = true })

  if not ok then
    return false, tostring(process)
  end

  local result = process:wait(4000)
  if result.code ~= 0 then
    local stderr = vim.trim(result.stderr or '')
    return false, stderr ~= '' and stderr or ('curl exited with code ' .. tostring(result.code))
  end

  return true, vim.trim(result.stdout or '')
end

function M.check()
  local health = health_api()
  local start = health.start or health.report_start
  local ok = health.ok or health.report_ok
  local warn = health.warn or health.report_warn
  local error = health.error or health.report_error

  start('s9.nvim')

  if vim.fn.has('nvim-0.10') == 1 then
    ok('Neovim 0.10 or newer')
  else
    error('Neovim 0.10 or newer is required (vim.system)')
  end

  if vim.fn.executable('curl') == 1 then
    ok('curl is available')
  else
    error('curl is required and was not found on PATH')
  end

  local config = require('s9.config').get()
  ok('API base URL: ' .. config.base_url)
  ok('Web base URL: ' .. config.web_url)

  do
    local session = require('s9.session')
    local stat = vim.uv.fs_stat(session.path())

    if not session.authenticated() then
      warn('not signed in; run :S9 login')
    else
      ok('a session cookie is stored')

      if stat then
        local mode = stat.mode % 512
        local text = string.format('session file permissions: %03o', mode)
        if mode == 384 or mode == 256 then
          ok(text)
        else
          warn(text .. ' (expected 600)')
        end
      end
    end
  end

  if vim.fn.executable('curl') == 1 then
    local reachable, detail = probe(config.base_url .. '/health')
    if reachable then
      ok('the API is reachable')
    else
      error('the API is not reachable: ' .. detail)
    end

    if reachable then
      local ready, ready_detail = probe(config.base_url .. '/health/ready')
      if ready then
        ok('the API is ready (database and queue connectivity)')
      else
        warn('the API is running but not ready: ' .. ready_detail)
      end
    end
  end
end

return M
