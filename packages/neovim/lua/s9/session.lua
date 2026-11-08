--- Session persistence.
---
--- Authentication is Better-Auth, so the API hands out an HttpOnly session
--- cookie. A plugin cannot read the browser's cookie jar, and the API has no
--- bearer-token flow for non-browser clients, so the plugin signs in with an
--- email and a password once and stores the resulting cookie in the Neovim
--- data directory, readable only by the current user.
---
--- The password itself is never stored.
local M = {}

local state = {
  loaded = false,
  cookies = nil, -- array of "name=value"
  user = nil,
  workspace = nil,
  role = nil,
}

local function file_path()
  return vim.fs.joinpath(vim.fn.stdpath('data'), 's9', 'session.json')
end

local function read_file(path)
  local file = io.open(path, 'r')
  if not file then
    return nil
  end
  local data = file:read('*a')
  file:close()
  return data
end

--- Extracts the session cookies from raw `Set-Cookie` header values.
---
--- Better-Auth may split a session across several cookies and prefixes them
--- with `__Secure-` / `__Host-` when the deployment is served over HTTPS, so
--- the filter looks for the configured `s9` cookie prefix anywhere in
--- the name instead of matching one exact name.
---@param values string[]
---@return string[] cookies
function M.parse_set_cookie(values)
  local cookies = {}
  local seen = {}

  for _, value in ipairs(values or {}) do
    local name = value:match('^%s*([^=;%s]+)=')
    if name and name:find('s9%.') and not seen[name] then
      seen[name] = true
      local pair = value:match('^%s*(' .. vim.pesc(name) .. '=[^;]*)')
      if pair then
        cookies[#cookies + 1] = pair
      end
    end
  end

  return cookies
end

function M.path()
  return file_path()
end

--- Loads the stored session once, then serves it from memory.
function M.load()
  if state.loaded then
    return
  end
  state.loaded = true

  local data = read_file(file_path())
  if not data then
    return
  end

  local ok, decoded = pcall(vim.json.decode, data)
  if not ok or type(decoded) ~= 'table' then
    return
  end

  if type(decoded.cookies) == 'table' then
    local cookies = {}
    for _, cookie in ipairs(decoded.cookies) do
      if type(cookie) == 'string' and cookie ~= '' then
        cookies[#cookies + 1] = cookie
      end
    end
    state.cookies = cookies
  end

  state.user = decoded.user
  state.workspace = decoded.workspace
  state.role = decoded.role
end

--- Writes the cookie jar to disk with owner-only permissions.
---@return boolean ok
---@return string|nil err
function M.save()
  local path = file_path()
  local dir = vim.fs.dirname(path)

  pcall(vim.fn.mkdir, dir, 'p', 448) -- 0700

  local payload = vim.json.encode({
    cookies = state.cookies or {},
    user = state.user,
    workspace = state.workspace,
    role = state.role,
    saved_at = os.time(),
  })

  -- Created with 0600 from the start: a session token must never be readable
  -- by another local user, even for the instant between write and chmod.
  local fd = vim.uv.fs_open(path, 'w', 384)
  if not fd then
    return false, 'could not write the session file at ' .. path
  end
  vim.uv.fs_write(fd, payload, 0)
  vim.uv.fs_close(fd)

  vim.uv.fs_chmod(path, 384) -- 0600
  return true
end

--- Replaces the cookie jar with the cookies of a successful sign-in.
---@param values string[] raw Set-Cookie header values
---@return boolean ok
---@return string|nil err
function M.store(values)
  local cookies = M.parse_set_cookie(values)
  state.cookies = cookies
  state.loaded = true
  return M.save()
end

--- Remembers the identity returned by `/api/me`.
---@param me table|nil
function M.identify(me)
  if type(me) == 'table' then
    state.user = me.user
    state.workspace = me.workspace
    state.role = me.role
    M.save()
  end
end

---@return string|nil
function M.cookie_header()
  M.load()
  if not state.cookies or #state.cookies == 0 then
    return nil
  end
  return table.concat(state.cookies, '; ')
end

---@return boolean
function M.authenticated()
  return M.cookie_header() ~= nil
end

---@return table|nil
function M.user()
  M.load()
  return state.user
end

---@return table|nil
function M.workspace()
  M.load()
  return state.workspace
end

---@return string|nil
function M.role()
  M.load()
  return state.role
end

--- Removes the stored session.
function M.clear()
  state.loaded = true
  state.cookies = nil
  state.user = nil
  state.workspace = nil
  state.role = nil
  pcall(os.remove, file_path())
end

return M
