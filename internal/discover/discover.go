package discover

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"sync"
	"time"
)

// Auto-discovery: ask Tailscale for the device list and probe each one for the receiver port.
//
// A new Mac that has run the deploy script shows up in the sender on its own;
// nobody types an IP into the UI. Adding and removing machines should never
// be the user's mental burden.

// tailscaleBin finds the tailscale CLI. Machines with Tailscale installed
// almost always have it, but not necessarily on PATH.
func tailscaleBin() string {
	candidates := []string{}
	if p, err := exec.LookPath("tailscale"); err == nil {
		candidates = append(candidates, p)
	}
	candidates = append(candidates,
		"/usr/local/bin/tailscale",
		`C:\Program Files\Tailscale\tailscale.exe`,
		// The GUI binary goes last: --version works, but status does not print
		// JSON; it was wrongly picked once when launchd's PATH lacked /usr/local/bin.
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
	)
	for _, c := range candidates {
		// Verify with the real command: it counts only if it runs and actually prints JSON.
		probe := exec.Command(c, "status", "--json")
		hideWindow(probe)
		out, err := probe.Output()
		if err == nil && len(out) > 0 && out[0] == '{' {
			return c
		}
	}
	return ""
}

// SelfName returns this machine's Tailscale device name (as set in the admin console).
// Returns "" if unavailable; the caller finds its own fallback.
//
// MagicDNS reverse lookup is preferred over the tailscale CLI: the App Store
// binary fails to start in launchd's stripped-down environment ("The
// Tailscale GUI failed to start"), while a DNS lookup is a pure network call
// that behaves the same everywhere.
func SelfName() string {
	if n := selfNameFromDNS(); n != "" {
		return n
	}
	return selfNameFromCLI()
}

// selfNameFromDNS finds our Tailscale IP (100.64/10 range) on the interfaces
// and resolves the device name via a MagicDNS PTR lookup.
func selfNameFromDNS() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		v4 := ipn.IP.To4()
		if v4 == nil || v4[0] != 100 || v4[1] < 64 || v4[1] > 127 {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		names, err := net.DefaultResolver.LookupAddr(ctx, v4.String())
		cancel()
		if err != nil || len(names) == 0 {
			return ""
		}
		// "huemac-mini-2.tailxxxx.ts.net." -> first label
		name := names[0]
		for i := 0; i < len(name); i++ {
			if name[i] == '.' {
				return name[:i]
			}
		}
		return name
	}
	return ""
}

func selfNameFromCLI() string {
	bin := tailscaleBin()
	if bin == "" {
		return ""
	}
	cmd := exec.Command(bin, "status", "--json")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	var st struct {
		Self struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
	}
	if json.Unmarshal(out, &st) != nil {
		return ""
	}
	// DNSName looks like "huemac-mini1.tailxxxx.ts.net."; the first label is the device name.
	name := st.Self.DNSName
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			return name[:i]
		}
	}
	return name
}

// tailnetPeers returns the IPv4 of every online device in the tailnet.
func tailnetPeers() ([]string, error) {
	bin := tailscaleBin()
	if bin == "" {
		return nil, fmt.Errorf("tailscale command not found")
	}
	cmd := exec.Command(bin, "status", "--json")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("tailscale status: %w", err)
	}
	var st struct {
		Peer map[string]struct {
			TailscaleIPs []string `json:"TailscaleIPs"`
			Online       bool     `json:"Online"`
		} `json:"Peer"`
	}
	if err := json.Unmarshal(out, &st); err != nil {
		return nil, err
	}
	ips := []string{}
	for _, p := range st.Peer {
		if !p.Online {
			continue
		}
		for _, ip := range p.TailscaleIPs {
			// IPv4 only (100.x.y.z)
			if len(ip) > 0 && ip[0] == '1' && !contains(ip, ':') {
				ips = append(ips, ip)
				break
			}
		}
	}
	return ips, nil
}

func contains(s string, c byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return true
		}
	}
	return false
}

// probeReceiver checks whether an IP is a receiver: a /ice-config response means yes.
// The timeout must be short: we scan the whole tailnet and most devices have no 7420 open.
func probeReceiver(ip string) bool {
	c := &http.Client{
		Timeout: 1500 * time.Millisecond,
		// receivers use self-signed certificates; this only checks liveness
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	}
	resp, err := c.Get("https://" + ip + ":7420/ice-config")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// Receivers scans the tailnet once and returns every receiver address. Probes
// run concurrently, so a round takes about one timeout (1.5s) rather than
// growing linearly with the device count.
func Receivers() ([]string, error) {
	ips, err := tailnetPeers()
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	found := []string{}
	for _, ip := range ips {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			if probeReceiver(ip) {
				mu.Lock()
				found = append(found, "https://"+ip+":7420")
				mu.Unlock()
			}
		}(ip)
	}
	wg.Wait()
	return found, nil
}
