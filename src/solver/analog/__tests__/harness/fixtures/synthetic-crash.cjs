// Synthetic kill-path fixture: exits immediately with a non-zero code.
// Used to validate the guard's CRASH-clean path: the parent must classify a
// non-zero exit (no result envelope) as a typed error and never itself crash.
// 139 is an arbitrary non-zero exit code chosen to stand in for an abnormal
// termination. NOTE: a *real* native fault on Windows surfaces as an NTSTATUS
// exit code (e.g. 3221225477 / 0xC0000005 for an access violation), not 139;
// this fixture only exercises non-zero-exit classification, so the exact value
// is immaterial as long as it is not 0.
process.stderr.write("synthetic-crash: aborting with non-zero exit code 139\n");
process.exit(139);
