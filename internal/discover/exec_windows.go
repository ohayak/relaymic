//go:build windows

package discover

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the child process from popping up a console window.
// When a GUI program (-H windowsgui) execs a command-line tool, Windows opens
// a visible cmd window for it by default; auto-discovery runs tailscale every
// 30s, so the user would see a black box flash every half minute.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
