--- Configuration for the s9 Neovim plugin.
---
--- Everything is optional: the defaults point at the development instance
--- described in the repository README.
local M = {}

---@class S9Config
---@field base_url string        API base URL, no trailing slash
---@field web_url string         Web app base URL, used for "open in browser"
---@field timeout_ms integer     Per-request timeout
---@field poll_interval_ms integer Refresh interval for in-flight executions
---@field page_size integer      Items fetched per list request (max 100)
---@field border string          Floating window border
---@field width number|integer   Float width: ratio (0..1) or columns
---@field height number|integer  Float height: ratio (0..1) or rows
---@field open_cmd string[]|nil  argv prefix used to open a URL; nil picks the platform default
---@field keymaps table<string, string> Opt-in global keymaps, e.g. { workflows = "<leader>fw" }

---@type S9Config
local defaults = {
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
}

---@type S9Config
local options = vim.deepcopy(defaults)

local function merge(dst, src)
  for key, value in pairs(src) do
    if type(value) == 'table' and type(dst[key]) == 'table' then
      merge(dst[key], value)
    else
      dst[key] = value
    end
  end
  return dst
end

local function normalize_url(name, value, fallback)
  if value == nil then
    return fallback
  end
  if type(value) ~= 'string' or value == '' then
    error(string.format('s9: %s must be a non-empty string', name))
  end
  return (value:gsub('/+$', ''))
end

--- Applies user options. Safe to call more than once.
---@param opts S9Config|nil
---@return S9Config
function M.setup(opts)
  options = merge(vim.deepcopy(defaults), opts or {})
  options.base_url = normalize_url('base_url', options.base_url, defaults.base_url)
  options.web_url = normalize_url('web_url', options.web_url, defaults.web_url)

  options.timeout_ms = math.max(1000, tonumber(options.timeout_ms) or defaults.timeout_ms)
  options.poll_interval_ms = math.max(250, tonumber(options.poll_interval_ms) or defaults.poll_interval_ms)
  options.page_size = math.max(1, math.min(100, tonumber(options.page_size) or defaults.page_size))

  return options
end

---@return S9Config
function M.get()
  return options
end

---@return S9Config
function M.defaults()
  return vim.deepcopy(defaults)
end

--- Restores the defaults. Used by the tests.
function M.reset()
  options = vim.deepcopy(defaults)
end

return M
