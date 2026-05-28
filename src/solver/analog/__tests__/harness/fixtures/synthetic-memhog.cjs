// Synthetic kill-path fixture: allocates committed memory in small increments.
// Used to validate the guard's Job Object MEMORY-CAP path under a LOW cap
// (e.g. 200 MB). The OS must tear it down near the cap.
//
// HARD SELF-ABORT BACKSTOP: if total ever exceeds ~1 GB, exit(7). This makes
// the test incapable of exhausting host RAM even if the Job Object code is
// wrong — at worst one process grows to ~1 GB then quits itself. The backstop
// firing (exit 7) would itself be a test failure signal (cap not enforced),
// but it can never crash the machine.
const chunks = [];
let total = 0;
setInterval(() => {
  // Touch every byte (Buffer.alloc zero-fills, forcing commit) so RSS actually
  // grows rather than reserving lazily.
  const b = Buffer.alloc(16 * 1024 * 1024, 1);
  chunks.push(b);
  total += b.length;
  if (total > 1e9) {
    process.stderr.write("synthetic-memhog: 1GB SELF-ABORT backstop fired\n");
    process.exit(7);
  }
}, 5);
