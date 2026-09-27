package main

import (
	"net"
	"testing"
)

// TestIsLocalSender pins down same-machine detection: loopback and local
// addresses count as local, nothing else does. The cost of an error is
// asymmetric: missing a local sender causes feedback, misjudging a remote one
// merely loses the return path.
func TestIsLocalSender(t *testing.T) {
	self := []net.IP{net.ParseIP("192.168.31.82"), net.ParseIP("100.100.100.100"), net.ParseIP("fd7a:115c:a1e0::bb38:735a")}
	cases := map[string]bool{
		"127.0.0.1:51234":                  true,
		"[::1]:51234":                      true,
		"[::ffff:127.0.0.1]:51234":         true,
		"192.168.31.82:51234":              true, // connecting to itself via its own LAN IP
		"100.100.100.100:51234":            true, // connecting to itself via its own tailnet IP
		"[fd7a:115c:a1e0::bb38:735a]:5123": true,
		"192.168.31.83:51234":              false,
		"100.100.100.101:51234":            false,
		"[fd7a:115c:a1e0::bb38:735b]:5123": false,
		"not-an-address":                   false,
	}
	for addr, want := range cases {
		if got := isLocalSender(addr, self); got != want {
			t.Errorf("isLocalSender(%q) = %v, want %v", addr, got, want)
		}
	}
}
