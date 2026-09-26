//go:build !windows

package discover

import "os/exec"

// hideWindow has nothing to do on non-Windows platforms.
func hideWindow(cmd *exec.Cmd) {}
