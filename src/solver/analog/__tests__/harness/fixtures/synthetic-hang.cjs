// Synthetic kill-path fixture: hangs forever doing nothing.
// Used to validate the guard's wall-clock TIMEOUT path. The guard must
// tree-kill this within timeoutMs and report a typed `timeout` error.
// It allocates no memory, so only the timer can stop it.
setInterval(() => {}, 1e9);
