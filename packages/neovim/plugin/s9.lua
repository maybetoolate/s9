if vim.g.loaded_s9 then
  return
end
vim.g.loaded_s9 = true

vim.api.nvim_create_user_command('S9', function(opts)
  require('s9').command(opts.fargs, opts.args)
end, {
  nargs = '*',
  desc = 'S9: workflows, executions and recovery',
  complete = function()
    return require('s9').complete()
  end,
})
